#pragma once
#include "plugin.h"
#include "kiss_fftr.h"
#include <deque>

namespace bk {
/** Streaming fixed-tempo estimate from actual pre-effect playback, with bounded history. */
class TempoAnalyzer {
  Event emit;
  std::string track;
  int64_t generation=0;
  double sampleRate=0,nextPosition=-1;
  int fftSize=0,hop=0;
  kiss_fftr_cfg fft=nullptr;
  std::vector<float> audio,window,fftInput,previous;
  std::vector<kiss_fft_cpx> spectrum;
  std::deque<float> envelope,baseline;
  size_t audioStart=0,totalFrames=0,lastAnalysis=0;
  std::deque<double> candidates;
  void reset(const Json&);
  void extract();
  void estimate();
public:
  explicit TempoAnalyzer(Event callback):emit(std::move(callback)){}
  ~TempoAnalyzer(){if(fft)kiss_fftr_free(fft);}
  void consume(const Json&,const std::vector<float>&);
};
bool tempoSelfTest();
}
