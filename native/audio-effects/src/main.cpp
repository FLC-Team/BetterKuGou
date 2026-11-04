#include "plugin.h"
#include "tempo.h"
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <cmath>
#include <cstring>
#ifdef _WIN32
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#else
#include <unistd.h>
#include <signal.h>
#endif

namespace bk {
using namespace Steinberg;using namespace Steinberg::Vst;
constexpr uint32_t maxJson=32*1024*1024,maxPcm=1024*1024;
struct Packet{Json header;std::vector<float> pcm;};
class Application:public HostApplication{
public:
  tresult PLUGIN_API getName(String128 name)override{const char16_t text[]=u"BetterKuGou";std::copy(std::begin(text),std::end(text),name);return kResultOk;}
  tresult PLUGIN_API queryInterface(const TUID requestedId,void** object)override{
#if SMTG_OS_LINUX
    if(FUnknownPrivate::iidEqual(requestedId,Linux::IRunLoop::iid))if(auto* loop=platformRunLoop())return loop->queryInterface(requestedId,object);
#endif
    return HostApplication::queryInterface(requestedId,object);
  }
};
static FILE* protocol=nullptr;
static uint32_t read32(const unsigned char* b){return uint32_t(b[0])|uint32_t(b[1])<<8|uint32_t(b[2])<<16|uint32_t(b[3])<<24;}
static void write32(unsigned char* b,uint32_t v){for(int i=0;i<4;i++)b[i]=static_cast<unsigned char>(v>>(8*i));}
/** Reserve original stdout before any third-party DLL is loaded; plugin diagnostics go to stderr. */
static void initializeProtocol(){
#ifdef _WIN32
  _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
  int fd=_dup(_fileno(stdout));protocol=_fdopen(fd,"wb");_dup2(_fileno(stderr),_fileno(stdout));SetStdHandle(STD_OUTPUT_HANDLE,GetStdHandle(STD_ERROR_HANDLE));
#else
  signal(SIGPIPE,SIG_IGN);protocol=fdopen(dup(STDOUT_FILENO),"wb");dup2(STDERR_FILENO,STDOUT_FILENO);
#endif
  if(!protocol)throw std::runtime_error("Cannot reserve protocol output");setvbuf(protocol,nullptr,_IONBF,0);
}
static bool readPacket(Packet& p){
  unsigned char size[8];size_t n=fread(size,1,8,stdin);if(!n)return false;if(n!=8)throw std::runtime_error("Truncated protocol header");
  uint32_t jsonSize=read32(size),pcmSize=read32(size+4);if(!jsonSize||jsonSize>maxJson||pcmSize>maxPcm||pcmSize%4)throw std::runtime_error("Invalid protocol lengths");
  std::string json(jsonSize,'\0');if(fread(json.data(),1,jsonSize,stdin)!=jsonSize)throw std::runtime_error("Truncated JSON packet");
  p.header=Json::parse(json);if(!p.header.is_object())throw std::runtime_error("Packet header must be an object");
  p.pcm.resize(pcmSize/4);if(pcmSize&&fread(p.pcm.data(),1,pcmSize,stdin)!=pcmSize)throw std::runtime_error("Truncated PCM packet");return true;
}
static bool writePacket(const Packet& p){std::string json=p.header.dump(-1,' ',false,Json::error_handler_t::replace);if(json.size()>maxJson||p.pcm.size()*4>maxPcm)return false;unsigned char size[8];write32(size,uint32_t(json.size()));write32(size+4,uint32_t(p.pcm.size()*4));return fwrite(size,1,8,protocol)==8&&fwrite(json.data(),1,json.size(),protocol)==json.size()&&(!p.pcm.size()||fwrite(p.pcm.data(),4,p.pcm.size(),protocol)==p.pcm.size());}

class Host{
  std::atomic<bool> running{true};
  std::atomic<bool> writerRunning{true};
  std::atomic<uint32_t> stableLatency{0};
  std::atomic<bool> watchdogStarted{false};
  std::atomic<uint64_t> flushRequested{0},flushCompleted{0};
  std::mutex queueMutex,outMutex,chainMutex,flushMutex;
  std::condition_variable work,outputReady,parametersFlushed;
  std::deque<Packet> controls,audio,analysis,outgoing;
  std::vector<std::shared_ptr<Plugin>> chain;
  IPtr<Application> application=owned(new Application);
  double sampleRate=48000;int blockSize=512;bool echo;
  std::thread reader,processor,analyzer,writer;
  // Third-party process()/terminate() may never return. After the supervising
  // pipe disappears this process must not survive as an orphan indefinitely.
  void shutdownWatchdog(){if(!watchdogStarted.exchange(true))std::thread([]{std::this_thread::sleep_for(std::chrono::seconds(2));std::_Exit(2);}).detach();}
  uint32_t latency()const{uint64_t total=0;for(const auto&p:chain)if(!p->bypassed)total+=p->latency;return uint32_t(std::min<uint64_t>(total,0xffffffff));}
  int64_t tail()const{uint64_t total=0;for(const auto&p:chain)if(!p->bypassed){if(p->tail==kInfiniteTail)return -1;total+=p->tail;}return int64_t(total);}
  void send(Json h,std::vector<float> pcm={}){
    std::lock_guard<std::mutex> lock(outMutex);if(outgoing.size()>=64){running=false;work.notify_all();return;}outgoing.push_back({std::move(h),std::move(pcm)});outputReady.notify_one();
  }
  void status(){stableLatency=latency();Json instances=Json::array();for(const auto&p:chain)instances.push_back({{"instanceId",p->instanceId},{"latencySamples",p->latency},{"bypassed",p->bypassed}});send({{"type","status"},{"running",true},{"latencySamples",stableLatency.load()},{"tailSamples",tail()},{"sampleRate",sampleRate},{"instances",instances}});}
  std::shared_ptr<Plugin> find(const Json& h){auto id=h.at("instanceId").get<std::string>();for(auto&p:chain)if(p->instanceId==id)return p;throw std::runtime_error("Unknown plug-in instance");}
  Json command(const Json& h){
    std::string name=h.at("command");
    if(name=="shutdown"){running=false;work.notify_all();return {{"stopped",true}};}
    if(name=="getState"){
      auto request=++flushRequested;work.notify_all();std::unique_lock<std::mutex> wait(flushMutex);
      if(!parametersFlushed.wait_for(wait,std::chrono::seconds(2),[&]{return flushCompleted.load()>=request||!running;})||!running)throw std::runtime_error("Audio processor did not confirm pending parameter changes; state was not saved");
    }
    std::lock_guard<std::mutex> guard(chainMutex);
    if(name=="configure"){
      double rate=h.value("sampleRate",48000.);int size=h.value("maxBlockSize",512);if(!std::isfinite(rate)||rate<8000||rate>384000||size<1||size>4096)throw std::runtime_error("Invalid processing setup");
      const auto& items=h.at("chain");if(!items.is_array()||items.size()>64)throw std::runtime_error("Invalid effects chain");
      std::vector<std::shared_ptr<Plugin>> next;std::unordered_map<std::string,bool> identities;
      for(const auto&item:items){auto id=item.at("instanceId").get<std::string>();if(id.empty()||id.size()>128||identities[id])throw std::runtime_error("Duplicate or invalid instance ID");identities[id]=true;std::shared_ptr<Plugin> plugin;
        for(auto&p:chain)if(p->instanceId==id&&p->path==item.at("path")&&p->classId==item.at("classId")){plugin=p;break;}
        if(!plugin){plugin=std::make_shared<Plugin>(item,application,[this](Json e){if(e.value("type","")=="status"&&e.contains("latencySamples")){status();return;}send(std::move(e));});plugin->configure(rate,size);}
        else if(sampleRate!=rate||blockSize!=size)plugin->configure(rate,size);
        plugin->bypassed=item.value("bypassed",false);next.push_back(std::move(plugin));
      }
      chain=std::move(next);sampleRate=rate;blockSize=size;status();return {{"sampleRate",rate},{"maxBlockSize",size},{"latencySamples",latency()},{"tailSamples",tail()},{"instances",chain.size()}};
    }
    if(name=="flush"){for(auto&p:chain)p->flush();return {{"flushed",true}};}
    if(name=="transport")return {{"updated",true}};
    auto p=find(h);
    if(name=="openEditor"){p->openEditor(h.value("alwaysOnTop",false));return {{"open",true}};}
    if(name=="closeEditor"){p->closeEditor();send({{"type","editor"},{"instanceId",p->instanceId},{"open",false}});return {{"open",false}};}
    if(name=="setBypass"){p->bypassed=h.at("bypassed").get<bool>();status();return {{"bypassed",p->bypassed},{"latencySamples",latency()},{"tailSamples",tail()}};}
    if(name=="getState")return p->getState();
    if(name=="setState"){p->stop();p->setState(h.at("state"));p->configure(sampleRate,blockSize);status();return {{"restored",true}};}
    if(name=="getParameters")return p->getParameters();
    if(name=="setParameter"){p->setParameter(h.at("paramId"),h.at("value"));return {{"updated",true}};}
    throw std::runtime_error("Unknown host command");
  }
  void readLoop(){try{Packet p;while(running&&readPacket(p)){std::string type=p.header.value("type","");std::lock_guard<std::mutex> lock(queueMutex);auto& q=type=="audio"?audio:type=="analysis"?analysis:controls;if(q.size()>=(type=="analysis"?8:32)){if(type=="analysis"){q.clear();}else throw std::runtime_error("Host input queue exceeded capacity");}q.push_back(std::move(p));work.notify_all();} }catch(const std::exception&e){send({{"type","status"},{"running",false},{"error",e.what()}});}shutdownWatchdog();running=false;work.notify_all();}
  void processLoop(){
    while(running){Packet p;bool haveAudio=false;{std::unique_lock<std::mutex> lock(queueMutex);work.wait_for(lock,std::chrono::milliseconds(50),[&]{return !running||!audio.empty()||flushRequested.load()>flushCompleted.load();});if(!audio.empty()){p=std::move(audio.front());audio.pop_front();haveAudio=true;}}
      try{
        if(!haveAudio||flushRequested.load()>flushCompleted.load()){
          std::unique_lock<std::mutex> lock(chainMutex,std::try_to_lock);
          if(lock.owns_lock()){auto request=flushRequested.load();for(auto& plugin:chain)plugin->flushParameters();flushCompleted=request;parametersFlushed.notify_all();}
          if(!haveAudio){std::this_thread::sleep_for(std::chrono::milliseconds(1));continue;}
        }
        if(echo&&p.header.value("testHang",false))for(;;)std::this_thread::sleep_for(std::chrono::seconds(1));
        int frames=p.header.at("frames"),channels=p.header.value("channels",2);double rate=p.header.at("sampleRate"),position=p.header.value("position",0.);if(frames<1||frames>4096||channels!=2||p.pcm.size()!=size_t(frames*2)||!std::isfinite(position))throw std::runtime_error("Invalid processing audio packet");
        std::unique_lock<std::mutex> lock(chainMutex,std::try_to_lock);
        if(!lock.owns_lock()){p.header["bypassed"]=true;p.header["reason"]="reconfiguring";p.header["latencySamples"]=stableLatency.load();}
        else {
          if(!echo&&(rate!=sampleRate||frames>blockSize))throw std::runtime_error("Audio format does not match configured host");
          ProcessContext context{};context.sampleRate=rate;context.projectTimeSamples=TSamples(position*rate);context.continousTimeSamples=context.projectTimeSamples;
          double tempo=p.header.value("tempo",120.);if(!std::isfinite(tempo)||tempo<20||tempo>400)tempo=120.;context.tempo=tempo;
          context.state=p.header.value("playing",true)?ProcessContext::kPlaying:0;
          // Musical position is a host grid anchored at song start, not an inferred downbeat map.
          if(p.header.value("tempoValid",true)){context.state|=ProcessContext::kTempoValid|ProcessContext::kProjectTimeMusicValid;context.projectTimeMusic=position*tempo/60.;}
          if(!echo)for(auto&plugin:chain)plugin->process(p.pcm.data(),frames,context);
          p.header["latencySamples"]=latency();
        }
        p.header["type"]="audio";send(std::move(p.header),std::move(p.pcm));
      }catch(const std::exception&e){send({{"type","status"},{"running",false},{"error",e.what()}});running=false;work.notify_all();parametersFlushed.notify_all();}
    }
  }
  void analysisLoop(){TempoAnalyzer detector([this](Json e){if(e.value("status","")=="estimated")e["status"]="detected";send(std::move(e));});while(running){Packet p;{std::unique_lock<std::mutex> lock(queueMutex);work.wait_for(lock,std::chrono::milliseconds(100),[&]{return !running||!analysis.empty();});if(analysis.empty())continue;p=std::move(analysis.front());analysis.pop_front();}try{detector.consume(p.header,p.pcm);}catch(const std::exception&e){send({{"type","tempo"},{"trackId",p.header.value("trackId","")},{"generation",p.header.value("generation",0)},{"status","uncertain"},{"error",e.what()}});}}}
  void writeLoop(){while(writerRunning){Packet p;{std::unique_lock<std::mutex> lock(outMutex);outputReady.wait_for(lock,std::chrono::milliseconds(100),[&]{return !writerRunning||!outgoing.empty();});if(outgoing.empty())continue;p=std::move(outgoing.front());outgoing.pop_front();}if(!writePacket(p)){shutdownWatchdog();running=false;work.notify_all();break;}}}
public:
  explicit Host(bool testing):echo(testing){PluginContextFactory::instance().setPluginContext(application);}
  int run(){
    writer=std::thread([this]{writeLoop();});reader=std::thread([this]{readLoop();});processor=std::thread([this]{processLoop();});analyzer=std::thread([this]{analysisLoop();});
    send({{"type","status"},{"running",true},{"ready",true},{"protocolVersion",1},{"latencySamples",0},{"sampleRate",sampleRate}});
    auto lastPump=std::chrono::steady_clock::now();
    while(running){
      platformPump();Packet p;bool have=false;{std::lock_guard<std::mutex> lock(queueMutex);if(!controls.empty()){p=std::move(controls.front());controls.pop_front();have=true;}}
      if(have){try{auto result=command(p.header);send({{"id",p.header.value("id",Json())},{"ok",true},{"result",std::move(result)}});}catch(const std::exception&e){send({{"id",p.header.value("id",Json())},{"ok",false},{"error",{{"code","NATIVE_HOST"},{"message",e.what()}}}});}}
      if(std::chrono::steady_clock::now()-lastPump>std::chrono::milliseconds(50)){std::lock_guard<std::mutex> lock(chainMutex);for(auto&p:chain)try{p->pump();}catch(const std::exception&e){send({{"type","status"},{"instanceId",p->instanceId},{"error",e.what()}});}lastPump=std::chrono::steady_clock::now();}
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    work.notify_all();processor.join();analyzer.join();{std::lock_guard<std::mutex> lock(chainMutex);chain.clear();}
    // Shutdown acknowledgement must leave the output queue before exiting; stdin may remain open in the parent.
    for(int i=0;i<200;i++){bool empty;{std::lock_guard<std::mutex> lock(outMutex);empty=outgoing.empty();}if(empty)break;std::this_thread::sleep_for(std::chrono::milliseconds(2));}
    writerRunning=false;outputReady.notify_all();writer.join();reader.detach();platformShutdown();return 0;
  }
};
}

static int appMain(int argc,char** argv){
  try{bk::initializeProtocol();
    if(argc>=2&&std::string(argv[1])=="--self-test"){bool pass=bk::tempoSelfTest();fprintf(bk::protocol,"%s\n",pass?"BPM self-test passed":"BPM self-test FAILED");return pass?0:1;}
    bk::platformInit();
    if(argc==3&&std::string(argv[1])=="--scan"){auto app=Steinberg::owned(new bk::Application);Steinberg::Vst::PluginContextFactory::instance().setPluginContext(app);auto result=bk::scan(argv[2],app);std::string text=result.dump(-1,' ',false,bk::Json::error_handler_t::replace);fwrite(text.data(),1,text.size(),bk::protocol);bk::platformShutdown();return 0;}
    if(argc!=2||(std::string(argv[1])!="--host"&&std::string(argv[1])!="--echo"))throw std::runtime_error("Use --host, --echo, --scan PATH or --self-test");
    auto* host=new bk::Host(std::string(argv[1])=="--echo");int result=host->run();
    // The detached reader may still hold stdin's FILE lock. Flush only the
    // private protocol stream after the writer has joined, never all stdio.
    std::fflush(bk::protocol);std::_Exit(result);
  }catch(const std::exception&e){std::cerr<<"audio-host: "<<e.what()<<'\n';return 1;}
}
#ifdef _WIN32
int wmain(int argc,wchar_t** argv){std::vector<std::string> strings;std::vector<char*> arguments;strings.reserve(argc);for(int i=0;i<argc;i++){int count=WideCharToMultiByte(CP_UTF8,0,argv[i],-1,nullptr,0,nullptr,nullptr);std::string s(count,'\0');WideCharToMultiByte(CP_UTF8,0,argv[i],-1,s.data(),count,nullptr,nullptr);s.resize(count-1);strings.push_back(std::move(s));}for(auto&s:strings)arguments.push_back(s.data());return appMain(argc,arguments.data());}
#else
int main(int argc,char** argv){return appMain(argc,argv);}
#endif
