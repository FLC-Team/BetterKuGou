#include "tempo.h"
#include <algorithm>
#include <cmath>
#include <numeric>
#include <cstdio>

namespace bk {
static constexpr double pi=3.14159265358979323846;
void TempoAnalyzer::reset(const Json& header){
  track=header.at("trackId").get<std::string>();generation=header.value("generation",int64_t(0));sampleRate=header.at("sampleRate").get<double>();
  if(!std::isfinite(sampleRate)||sampleRate<8000||sampleRate>384000)throw std::runtime_error("Unsupported analysis sample rate");
  fftSize=1<<int(std::round(std::log2(sampleRate*.046)));hop=std::max(1,int(std::round(sampleRate/100)));
  if(fft)kiss_fftr_free(fft);fft=kiss_fftr_alloc(fftSize,0,nullptr,nullptr);if(!fft)throw std::bad_alloc();
  window.resize(fftSize);for(int i=0;i<fftSize;i++)window[i]=float(.5-.5*std::cos(2*pi*i/(fftSize-1)));
  fftInput.resize(fftSize);spectrum.resize(fftSize/2+1);previous.assign(fftSize/2+1,0);
  audio.clear();audioStart=0;envelope.clear();baseline.clear();candidates.clear();totalFrames=lastAnalysis=0;nextPosition=-1;
}
void TempoAnalyzer::consume(const Json& h,const std::vector<float>& samples){
  int frames=h.at("frames"),channels=h.value("channels",1);double position=h.value("position",0.);
  if(frames<1||frames>262144||channels<1||channels>2||samples.size()!=size_t(frames)*channels||!std::isfinite(position))throw std::runtime_error("Invalid tempo audio packet");
  if(!fft||track!=h.at("trackId").get<std::string>()||generation!=h.value("generation",int64_t(0))||sampleRate!=h.at("sampleRate").get<double>()||(nextPosition>=0&&std::abs(position-nextPosition)>.05))reset(h);
  nextPosition=position+frames/sampleRate;
  // Only a short PCM overlap is retained. Stereo cancellation naturally produces an uncertain result.
  for(int i=0;i<frames;i++){float v=samples[i];if(channels==2)v=.5f*(v+samples[frames+i]);audio.push_back(std::isfinite(v)?v:0.f);}
  while(audio.size()-audioStart>=size_t(fftSize)){extract();audioStart+=hop;}
  if(audioStart>size_t(fftSize*4)){audio.erase(audio.begin(),audio.begin()+audioStart);audioStart=0;}
}
void TempoAnalyzer::extract(){
  double energy=0;for(int i=0;i<fftSize;i++){float v=audio[audioStart+i];fftInput[i]=v*window[i];energy+=v*v;}
  kiss_fftr(fft,fftInput.data(),spectrum.data());double flux=0,spectralLevel=0;
  const int minBin=std::max(1,int(40*fftSize/sampleRate)),maxBin=std::min(fftSize/2,int(5000*fftSize/sampleRate));
  for(int i=minBin;i<=maxBin;i++){float magnitude=std::sqrt(spectrum[i].r*spectrum[i].r+spectrum[i].i*spectrum[i].i)/fftSize;float v=std::log1p(100*magnitude);flux+=std::max(0.f,v-previous[i]);spectralLevel+=v;previous[i]=v;}
  // Reject tiny FFT window/phase ripples of sustained tones before correlation.
  if(energy/fftSize<1e-10||flux<spectralLevel*.002)flux=0;
  baseline.push_back(float(flux));if(baseline.size()>size_t(std::round(sampleRate/hop)))baseline.pop_front();
  double mean=std::accumulate(baseline.begin(),baseline.end(),0.)/baseline.size();
  envelope.push_back(float(std::max(0.,flux-mean)));double fps=sampleRate/hop;
  if(envelope.size()>size_t(std::round(fps*32)))envelope.pop_front();totalFrames++;
  if(totalFrames>=size_t(fps*16)&&totalFrames-lastAnalysis>=size_t(fps*4)){lastAnalysis=totalFrames;estimate();}
}
void TempoAnalyzer::estimate(){
  const double fps=sampleRate/hop;int minLag=int(std::floor(60*fps/240)),maxLag=int(std::ceil(60*fps/40));
  std::vector<double> correlation(maxLag+2,0);double sum=0;for(float v:envelope)sum+=v*v;
  if(sum<1e-8){candidates.clear();emit({{"type","tempo"},{"trackId",track},{"generation",generation},{"status","uncertain"},{"bpm",nullptr},{"confidence",0}});return;}
  for(int lag=minLag-1;lag<=maxLag+1;lag++){double product=0,left=0,right=0;for(size_t i=lag;i<envelope.size();i++){double a=envelope[i],b=envelope[i-lag];product+=a*b;left+=a*a;right+=b*b;}correlation[lag]=product/std::sqrt(std::max(1e-20,left*right));}
  struct Peak{double bpm,score,correlation;};std::vector<Peak> peaks;
  for(int lag=minLag;lag<=maxLag;lag++)if(correlation[lag]>correlation[lag-1]&&correlation[lag]>=correlation[lag+1]){
    double denominator=correlation[lag-1]-2*correlation[lag]+correlation[lag+1];double delta=std::abs(denominator)<1e-10?0:.5*(correlation[lag-1]-correlation[lag+1])/denominator;
    double bpm=60*fps/(lag+std::clamp(delta,-.5,.5));if(bpm>=40&&bpm<=240)peaks.push_back({bpm,correlation[lag]*(1-.12*lag/maxLag),correlation[lag]});
  }
  std::sort(peaks.begin(),peaks.end(),[](const Peak&a,const Peak&b){return a.score>b.score;});
  if(peaks.empty()){candidates.clear();return;}
  // Sampling the onset envelope slightly attenuates non-integral periods. Prefer a
  // comparably strong fundamental over its two/three/four-period subharmonic.
  auto best=peaks.front();
  for(const auto& peak:peaks){double ratio=peak.bpm/best.bpm;double multiple=std::round(ratio);if(multiple>=2&&multiple<=4&&std::abs(ratio-multiple)<.06&&peak.correlation>=best.correlation*.8)best=peak;}
  double confidence=std::clamp(best.correlation,0.,1.);
  candidates.push_back(best.bpm);if(candidates.size()>3)candidates.pop_front();
  double minimum=*std::min_element(candidates.begin(),candidates.end()),maximum=*std::max_element(candidates.begin(),candidates.end());
  bool stable=candidates.size()==3&&(maximum-minimum)/best.bpm<=.02&&confidence>=.55;
  Json alternatives=Json::array();for(size_t i=0;i<std::min<size_t>(3,peaks.size());i++)alternatives.push_back({{"bpm",std::round(peaks[i].bpm*10)/10},{"score",peaks[i].score}});
  emit({{"type","tempo"},{"trackId",track},{"generation",generation},{"status",stable?"estimated":"analyzing"},{"bpm",std::round(best.bpm*10)/10},{"confidence",confidence},{"candidates",alternatives},{"algorithmVersion",1},{"analyzedSeconds",double(totalFrames)/fps}});
}
bool tempoSelfTest(){
  for(double rate:{44100.,48000.,96000.,192000.})for(double bpm:{60.,90.,120.,150.,180.,210.}){
    double result=0;TempoAnalyzer a([&](Json e){if(e.value("status","")=="estimated")result=e["bpm"].get<double>();});
    const int block=512;std::vector<float> pcm(block);for(int offset=0;offset<int(rate*29);offset+=block){for(int i=0;i<block;i++){double beat=std::fmod((offset+i)/rate,60/bpm);pcm[i]=beat<.035?float(.7*std::exp(-beat*140)*std::sin(2*pi*110*beat)):0;}
      a.consume({{"trackId","test"},{"generation",1},{"sampleRate",rate},{"channels",1},{"frames",block},{"position",offset/rate}},pcm);
    }if(std::abs(result-bpm)>1.){std::fprintf(stderr,"BPM self-test: sampleRate=%.0f expected=%.1f detected=%.1f\n",rate,bpm,result);return false;}
  }
  bool falsePositive=false;TempoAnalyzer silence([&](Json e){if(e.value("status","")=="estimated")falsePositive=true;});std::vector<float> zeros(512,0);for(int offset=0;offset<48000*29;offset+=512)silence.consume({{"trackId","silence"},{"generation",1},{"sampleRate",48000},{"channels",1},{"frames",512},{"position",offset/48000.}},zeros);
  if(falsePositive)return false;
  for(bool noise:{false,true}){
    TempoAnalyzer a([&](Json e){if(e.value("status","")=="estimated")falsePositive=true;});std::vector<float> pcm(512);uint32_t random=1234567;
    for(int offset=0;offset<48000*29;offset+=512){for(int i=0;i<512;i++){random=1664525*random+1013904223;pcm[i]=noise?float((double(random)/4294967296.-.5)*.2):float(.2*std::sin(2*pi*440*(offset+i)/48000.));}a.consume({{"trackId","unpitched"},{"generation",1},{"sampleRate",48000},{"channels",1},{"frames",512},{"position",offset/48000.}},pcm);}
    if(falsePositive){std::fprintf(stderr,"BPM self-test false positive on %s\n",noise?"unmodulated noise":"steady tone");return false;}
  }
  // Invalid first-packet metadata must fail before FFT sizing or sample products.
  TempoAnalyzer invalid([](Json){});int rejected=0;
  for(const auto& header:{Json{{"trackId",""},{"generation",0},{"sampleRate",0},{"channels",1},{"frames",1}},Json{{"trackId","invalid"},{"sampleRate",48000},{"channels",2},{"frames",2147483647}}}){
    try{invalid.consume(header,std::vector<float>{0});}catch(const std::exception&){rejected++;}
  }
  if(rejected!=2)return false;
  return true;
}
}
