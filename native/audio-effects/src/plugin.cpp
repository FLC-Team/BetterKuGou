#include "plugin.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/utility/stringconvert.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/connectionproxy.h"
#include <deque>
#include <mutex>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace bk {
using namespace Steinberg;using namespace Steinberg::Vst;
/** SDK's example proxy drops worker-thread messages. Queue these to the GUI
 * thread so separated processors/controllers can complete their handshakes. */
class MessageRelay:public ConnectionProxy{
  std::mutex mutex;
  std::deque<IPtr<IMessage>> pending;
public:
  explicit MessageRelay(IConnectionPoint* source):ConnectionProxy(source){}
  tresult PLUGIN_API notify(IMessage* message)override{
    if(!message)return kInvalidArgument;
    if(threadChecker->test())return ConnectionProxy::notify(message);
    std::unique_lock<std::mutex> lock(mutex,std::try_to_lock);
    if(!lock.owns_lock()||pending.size()>=256)return kResultFalse;
    pending.emplace_back(message);return kResultOk;
  }
  void pump(){std::deque<IPtr<IMessage>> next;{std::lock_guard<std::mutex> lock(mutex);next.swap(pending);}for(auto&message:next)ConnectionProxy::notify(message);}
};
class Provider:public PlugProvider{
public:
  using PlugProvider::PlugProvider;
  ~Provider()override{if(controller)controller->setComponentHandler(nullptr);}
  void initializeHosted(FUnknown* context,IComponentHandler* handler){
    component=factory.createInstance<IComponent>(classInfo.ID());
    if(!component||component->initialize(context)!=kResultOk)throw std::runtime_error("Cannot initialize VST3 component");
    controller=FUnknownPtr<IEditController>(component);
    if(!controller){TUID id{};if(component->getControllerClassId(id)==kResultOk){controller=factory.createInstance<IEditController>(VST3::UID(id));if(!controller||controller->initialize(context)!=kResultOk)throw std::runtime_error("Cannot initialize VST3 controller");}}
    // Install callbacks before connect(): controllers may publish initial values
    // or restart requests while establishing their processor connection.
    if(controller)controller->setComponentHandler(handler);
    if(controller&&FUnknownPtr<IEditController>(component).getInterface()!=controller.get()){
      auto componentPoint=U::cast<IConnectionPoint>(component),controllerPoint=U::cast<IConnectionPoint>(controller);
      if(componentPoint&&controllerPoint){
        componentCP=owned(new MessageRelay(componentPoint));controllerCP=owned(new MessageRelay(controllerPoint));
        if(componentCP->connect(controllerPoint)!=kResultOk||controllerCP->connect(componentPoint)!=kResultOk)throw std::runtime_error("Cannot connect VST3 controller messaging");
      }
    }
  }
  void pump(){if(componentCP)static_cast<MessageRelay*>(componentCP.get())->pump();if(controllerCP)static_cast<MessageRelay*>(controllerCP.get())->pump();}
};
static constexpr size_t maxState=23*1024*1024;
static const char* alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static std::string encode(const char* bytes,size_t count) {
  if(count>maxState)throw std::runtime_error("Plug-in state exceeds 23 MiB; state was not saved");
  std::string out;out.reserve((count+2)/3*4);
  for(size_t i=0;i<count;i+=3){uint32_t x=uint8_t(bytes[i])<<16;if(i+1<count)x|=uint8_t(bytes[i+1])<<8;if(i+2<count)x|=uint8_t(bytes[i+2]);out+=alphabet[(x>>18)&63];out+=alphabet[(x>>12)&63];out+=i+1<count?alphabet[(x>>6)&63]:'=';out+=i+2<count?alphabet[x&63]:'=';}
  return out;
}
static std::vector<char> decode(const std::string& s){
  if(s.size()%4 || s.size()>((maxState+2)/3*4))throw std::runtime_error("Invalid or oversized plug-in state");
  std::vector<char> out;out.reserve(s.size()/4*3);uint32_t acc=0;int bits=0;bool padding=false;
  for(char c:s){if(c=='='){padding=true;continue;}const char* p=std::strchr(alphabet,c);if(padding||!p||!c)throw std::runtime_error("Invalid base64 plug-in state");acc=(acc<<6)|uint32_t(p-alphabet);bits+=6;if(bits>=8){bits-=8;out.push_back(char(acc>>bits));}}
  return out;
}
class LimitedStream:public MemoryStream{
public:
  bool exceeded=false;
  tresult PLUGIN_API write(void* b,int32 n,int32* done)override{int64 pos=0;tell(&pos);if(n<0||pos+n>int64(maxState)){exceeded=true;if(done)*done=0;return kOutOfMemory;}return MemoryStream::write(b,n,done);}
};
bool Plugin::Changes::push(Change c){unsigned w=write.load(std::memory_order_relaxed);unsigned next=unsigned((w+1)%items.size());if(next==read.load(std::memory_order_acquire))return false;items[w]=c;write.store(next,std::memory_order_release);return true;}
bool Plugin::Changes::pop(Change& c){auto r=read.load(std::memory_order_relaxed);if(r==write.load(std::memory_order_acquire))return false;c=items[r];read.store((r+1)%items.size(),std::memory_order_release);return true;}
class Plugin::Handler:public U::Implements<U::Directly<IComponentHandler,IComponentHandler2>>{
  Plugin& owner;
public:
  explicit Handler(Plugin&p):owner(p){}
  tresult PLUGIN_API beginEdit(ParamID)override{return kResultOk;}
  tresult PLUGIN_API performEdit(ParamID id,ParamValue v)override{if(!std::isfinite(v))return kInvalidArgument;owner.dirty=true;return owner.inputChanges.push({id,std::clamp(v,0.,1.)})?kResultOk:kResultFalse;}
  tresult PLUGIN_API endEdit(ParamID)override{owner.dirty=true;return kResultOk;}
  tresult PLUGIN_API restartComponent(int32 flags)override{owner.restartFlags.fetch_or(flags);return kResultOk;}
  tresult PLUGIN_API setDirty(TBool value)override{owner.dirty=value!=0;return kResultOk;}
  tresult PLUGIN_API requestOpenEditor(FIDString)override{owner.editorRequested=true;return kResultOk;}
  tresult PLUGIN_API startGroupEdit()override{return kResultOk;}
  tresult PLUGIN_API finishGroupEdit()override{return kResultOk;}
};
class Plugin::Frame:public U::Implements<U::Directly<IPlugFrame>>{
  Plugin& owner;
public:
  explicit Frame(Plugin&p):owner(p){}
  tresult PLUGIN_API queryInterface(const TUID requestedId,void** obj)override{
#if SMTG_OS_LINUX
    if(FUnknownPrivate::iidEqual(requestedId,Linux::IRunLoop::iid))if(auto* loop=platformRunLoop())return loop->queryInterface(requestedId,obj);
#endif
    return U::Implements<U::Directly<IPlugFrame>>::queryInterface(requestedId,obj);
  }
  tresult PLUGIN_API resizeView(IPlugView* v,ViewRect* r)override{
    if(v!=owner.view.get()||!r||!owner.window)return kInvalidArgument;
    int w=r->getWidth(),h=r->getHeight();if(w<40||h<40||w>8192||h>8192)return kInvalidArgument;
    if(owner.resizing)return kResultOk;owner.resizing=true;owner.window->resize(w,h);v->onSize(r);owner.resizing=false;return kResultOk;
  }
};
Plugin::Plugin(const Json& item,FUnknown* context,Event event):instanceId(item.at("instanceId").get<std::string>()),path(item.at("path").get<std::string>()),classId(item.at("classId").get<std::string>()),emit(std::move(event)) {
  handler=owned(new Handler(*this));frame=owned(new Frame(*this));
  std::string error;module=VST3::Hosting::Module::create(path,error);if(!module)throw std::runtime_error(error);
  module->getFactory().setHostContext(context);bool found=false;
  for(const auto& info:module->getFactory().classInfos())if(info.ID().toString()==classId && info.category()==kVstAudioEffectClass){
    if(info.subCategoriesString().find("Instrument")!=std::string::npos)throw std::runtime_error("Instrument plug-ins are not supported");
    auto customProvider=owned(new Provider(module->getFactory(),info,true));provider=customProvider;
    customProvider->initializeHosted(context,handler);name=info.name();found=true;break;
  }
  if(!found)throw std::runtime_error("VST3 audio effect class not found");
  component=provider->getComponentPtr();controller=provider->getControllerPtr();processor=FUnknownPtr<IAudioProcessor>(component);
  if(!component||!processor)throw std::runtime_error("Missing VST3 audio processor");
  if(controller){LimitedStream initial;if(component->getState(&initial)==kResultOk&&!initial.exceeded){initial.seek(0,IBStream::kIBSeekSet,nullptr);controller->setComponentState(&initial);}}
  bypassed=item.value("bypassed",false);if(item.contains("state")&&!item["state"].is_null())setState(item["state"]);
}
Plugin::~Plugin(){closeEditor();stop();if(controller)controller->setComponentHandler(nullptr);processor=nullptr;controller=nullptr;component=nullptr;provider=nullptr;}
void Plugin::stop(){if(processing){processor->setProcessing(false);processing=false;}if(active){component->setActive(false);active=false;}data.unprepare();}
/** Negotiate stereo main buses, leave all auxiliary/event inputs inactive, and preallocate all processing buffers. */
void Plugin::configure(double sampleRate,int block){
  stop();rate=sampleRate;maxBlock=block;
  int ni=component->getBusCount(kAudio,kInput),no=component->getBusCount(kAudio,kOutput);
  if(ni<1||no<1||ni>32||no>32)throw std::runtime_error("Effect requires unsupported audio buses");
  std::vector<SpeakerArrangement> in(ni),out(no);for(int i=0;i<ni;i++)processor->getBusArrangement(kInput,i,in[i]);for(int i=0;i<no;i++)processor->getBusArrangement(kOutput,i,out[i]);
  in[0]=SpeakerArr::kStereo;out[0]=SpeakerArr::kStereo;
  processor->setBusArrangements(in.data(),ni,out.data(),no);
  BusInfo input{},output{};component->getBusInfo(kAudio,kInput,0,input);component->getBusInfo(kAudio,kOutput,0,output);
  if(input.channelCount!=2||output.channelCount!=2)throw std::runtime_error("First release requires stereo input and stereo output");
  for(auto direction:{kInput,kOutput})for(auto type:{kAudio,kEvent})for(int i=0;i<component->getBusCount(type,direction);i++){
    BusInfo bus{};if(component->getBusInfo(type,direction,i,bus)!=kResultOk||bus.channelCount<0||bus.channelCount>64)throw std::runtime_error("Invalid VST3 bus channels");
    auto result=component->activateBus(type,direction,i,type==kAudio&&i==0);
    if(type==kAudio&&i==0&&result!=kResultOk)throw std::runtime_error("Cannot activate VST3 stereo bus");
  }
  precision=processor->canProcessSampleSize(kSample32)==kResultOk?kSample32:kSample64;
  if(processor->canProcessSampleSize(precision)!=kResultOk)throw std::runtime_error("Effect supports no floating-point format");
  ProcessSetup setup{kRealtime,precision,block,sampleRate};if(processor->setupProcessing(setup)!=kResultOk)throw std::runtime_error("VST3 setupProcessing failed");
  if(!data.prepare(*component,block,precision))throw std::runtime_error("Cannot prepare VST3 buffers");
  data.processMode=kRealtime;data.inputParameterChanges=&inputs;data.outputParameterChanges=&outputs;
  if(component->setActive(true)!=kResultOk)throw std::runtime_error("Cannot activate VST3 component");active=true;
  latency=processor->getLatencySamples();tail=processor->getTailSamples();
}
void Plugin::flush(){if(processing){processor->setProcessing(false);processor->setProcessing(true);}inputs.clearQueue();outputs.clearQueue();}
/** Commit paused GUI edits using VST3's zero-sample parameter flush, exclusively
 * on the processing thread. Bypassed instances must persist their edits too. */
void Plugin::flushParameters(){
  if(inputChanges.read.load(std::memory_order_acquire)==inputChanges.write.load(std::memory_order_acquire))return;
  bool wasBypassed=bypassed;bypassed=false;ProcessContext context{};context.sampleRate=rate;
  try{process(nullptr,0,context);}catch(...){bypassed=wasBypassed;throw;}
  bypassed=wasBypassed;
}
/** Called only by the processing thread while the chain is stable. GUI edits cross bounded atomic queues. */
void Plugin::process(float* pcm,int frames,ProcessContext& context){
  if(bypassed)return;if(!processing){if(processor->setProcessing(true)!=kResultOk)throw std::runtime_error("Cannot start VST3 processing");processing=true;}data.numSamples=frames;data.processContext=&context;inputs.clearQueue();outputs.clearQueue();
  Change change;while(inputChanges.pop(change)){int32 index=0;auto* q=inputs.addParameterData(change.id,index);q->addPoint(0,change.value,index);}
  for(int b=0;b<data.numInputs;b++){auto& bus=data.inputs[b];bus.silenceFlags=b==0?0:HostProcessData::kAllChannelsSilent;for(int c=0;c<bus.numChannels;c++)for(int i=0;i<frames;i++){double value=b==0&&c<2?pcm[c*frames+i]:0;if(precision==kSample32)bus.channelBuffers32[c][i]=float(value);else bus.channelBuffers64[c][i]=value;}}
  for(int b=0;b<data.numOutputs;b++){data.outputs[b].silenceFlags=0;for(int c=0;c<data.outputs[b].numChannels;c++){if(precision==kSample32)std::fill_n(data.outputs[b].channelBuffers32[c],frames,0.f);else std::fill_n(data.outputs[b].channelBuffers64[c],frames,0.);}}
  inputEvents.clear();outputEvents.clear();data.inputEvents=&inputEvents;data.outputEvents=&outputEvents;
  if(processor->process(data)!=kResultOk)throw std::runtime_error("VST3 process returned failure");
  for(int c=0;c<2;c++)for(int i=0;i<frames;i++){double v=precision==kSample32?data.outputs[0].channelBuffers32[c][i]:data.outputs[0].channelBuffers64[c][i];if(!std::isfinite(v))throw std::runtime_error("VST3 produced non-finite audio");pcm[c*frames+i]=float(v);}
  for(int i=0;i<outputs.getParameterCount();i++){auto* q=outputs.getParameterData(i);int32 offset;double value;if(q->getPoint(q->getPointCount()-1,offset,value)==kResultOk)outputChanges.push({q->getParameterId(),value});}
}
void Plugin::openEditor(bool top){
  if(window){window->show(top);return;}if(!controller)throw std::runtime_error("Effect has no edit controller");
  view=owned(controller->createView(ViewType::kEditor));if(!view)throw std::runtime_error("Effect has no native editor");
  ViewRect r{};if(view->getSize(&r)!=kResultOk)r=ViewRect(0,0,600,400);
  window=createWindow(name+" — BetterKuGou",std::clamp(r.getWidth(),100,8192),std::clamp(r.getHeight(),100,8192),{
    [this]{closeRequested=true;},[this](int w,int h){if(!view||!window||resizing)return;ViewRect size(0,0,w,h);view->checkSizeConstraint(&size);resizing=true;view->onSize(&size);resizing=false;}});
  view->setFrame(frame);
  if(view->isPlatformTypeSupported(window->type())!=kResultOk||view->attached(window->handle(),window->type())!=kResultOk){view->setFrame(nullptr);view=nullptr;window.reset();throw std::runtime_error("Plug-in editor does not support this window platform");}
  closeRequested=false;window->show(top);emit({{"type","editor"},{"instanceId",instanceId},{"open",true}});
}
void Plugin::closeEditor(){if(view){view->removed();view->setFrame(nullptr);view=nullptr;}window.reset();closeRequested=false;}
void Plugin::pump(){
  static_cast<Provider*>(provider.get())->pump();
  if(editorRequested.exchange(false))openEditor(false);
  if(closeRequested){closeEditor();emit({{"type","editor"},{"instanceId",instanceId},{"open",false}});}
  Change c;Json changes=Json::array();while(outputChanges.pop(c)){if(controller)controller->setParamNormalized(c.id,c.value);changes.push_back({{"paramId",c.id},{"value",c.value}});}
  if(!changes.empty())emit({{"type","parameters"},{"instanceId",instanceId},{"changes",changes}});
  int flags=restartFlags.exchange(0);auto oldLatency=latency,oldTail=tail;
  if(flags&(kIoChanged|kReloadComponent))configure(rate,maxBlock);
  if(flags&kLatencyChanged)latency=processor->getLatencySamples();tail=processor->getTailSamples();
  if(oldLatency!=latency||oldTail!=tail)emit({{"type","status"},{"instanceId",instanceId},{"latencySamples",latency}});
  if(flags&kParamValuesChanged)for(int i=0;controller&&i<std::min(4096,controller->getParameterCount());i++){ParameterInfo info{};if(controller->getParameterInfo(i,info)==kResultOk)inputChanges.push({info.id,controller->getParamNormalized(info.id)});}
  if(flags&(kParamValuesChanged|kParamTitlesChanged)){emit({{"type","parameters"},{"instanceId",instanceId},{"invalidated",true}});}
  if(dirty.exchange(false))emit({{"type","status"},{"instanceId",instanceId},{"dirty",true}});
}
Json Plugin::getState(){LimitedStream a,b;if(component->getState(&a)!=kResultOk)throw std::runtime_error("Plug-in could not save component state");if(controller)controller->getState(&b);if(a.exceeded||b.exceeded||a.getSize()+b.getSize()>maxState)throw std::runtime_error("Plug-in state exceeds save limit; previous saved state is retained");return {{"component",encode(a.getData(),size_t(a.getSize()))},{"controller",encode(b.getData(),size_t(b.getSize()))}};}
void Plugin::setState(const Json& state){
  auto a=decode(state.value("component",std::string{})),b=decode(state.value("controller",std::string{}));
  // This is called with processing stopped/excluded. Old queued edits must not
  // overwrite the restored DSP state when the next audio block arrives.
  Change pending;while(inputChanges.pop(pending)){}while(outputChanges.pop(pending)){}inputs.clearQueue();outputs.clearQueue();
  if(!a.empty()){MemoryStream stream(a.data(),a.size());if(component->setState(&stream)!=kResultOk)throw std::runtime_error("Plug-in rejected saved component state");stream.seek(0,IBStream::kIBSeekSet,nullptr);if(controller)controller->setComponentState(&stream);}
  if(controller&&!b.empty()){MemoryStream stream(b.data(),b.size());controller->setState(&stream);}
}
Json Plugin::getParameters(){Json result=Json::array();if(!controller)return result;for(int i=0;i<std::min(controller->getParameterCount(),4096);i++){ParameterInfo info{};if(controller->getParameterInfo(i,info)!=kResultOk)continue;String128 display{};double value=controller->getParamNormalized(info.id);controller->getParamStringByValue(info.id,value,display);result.push_back({{"paramId",info.id},{"title",StringConvert::convert(info.title)},{"units",StringConvert::convert(info.units)},{"value",value},{"display",StringConvert::convert(display)},{"stepCount",info.stepCount},{"readOnly",bool(info.flags&ParameterInfo::kIsReadOnly)}});}return result;}
void Plugin::setParameter(uint32_t id,double value){if(!controller||!std::isfinite(value)||value<0||value>1)throw std::runtime_error("Invalid parameter value");bool found=false;for(int i=0;i<controller->getParameterCount();i++){ParameterInfo info{};if(controller->getParameterInfo(i,info)==kResultOk&&info.id==id){if(info.flags&ParameterInfo::kIsReadOnly)throw std::runtime_error("Read-only parameter");found=true;break;}}if(!found)throw std::runtime_error("Unknown parameter");controller->setParamNormalized(id,value);handler->performEdit(id,value);}
Json scan(const std::string& path,FUnknown* context){
  std::string error;auto module=VST3::Hosting::Module::create(path,error);if(!module)throw std::runtime_error(error);module->getFactory().setHostContext(context);Json result=Json::array();
  for(const auto& info:module->getFactory().classInfos())if(info.category()==kVstAudioEffectClass){bool editor=false;auto provider=owned(new PlugProvider(module->getFactory(),info,true));if(provider->initialize()){auto controller=provider->getControllerPtr();if(controller){auto view=owned(controller->createView(ViewType::kEditor));editor=bool(view);}}
    result.push_back({{"path",path},{"classId",info.ID().toString()},{"name",info.name()},{"vendor",info.vendor().empty()?module->getFactory().info().vendor():info.vendor()},{"category",info.subCategoriesString()},{"version",info.version()},{"isEffect",info.subCategoriesString().find("Instrument")==std::string::npos},{"hasEditor",editor}});
  }return result;
}
}
