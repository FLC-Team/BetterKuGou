#pragma once
#include <nlohmann/json.hpp>
#include <array>
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <vector>
#include "platform.h"
#include "pluginterfaces/gui/iplugview.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/hosting/processdata.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

namespace bk {
using Json=nlohmann::json;
using Event=std::function<void(Json)>;
class Plugin {
  class Handler;
  class Frame;
  struct Change {Steinberg::Vst::ParamID id;double value;};
  struct Changes {
    std::array<Change,4096> items{};std::atomic<unsigned> read{0},write{0};
    bool push(Change);bool pop(Change&);
  } inputChanges,outputChanges;
  VST3::Hosting::Module::Ptr module;
  Steinberg::IPtr<Steinberg::Vst::PlugProvider> provider;
  Steinberg::IPtr<Steinberg::Vst::IComponent> component;
  Steinberg::IPtr<Steinberg::Vst::IEditController> controller;
  Steinberg::IPtr<Steinberg::Vst::IAudioProcessor> processor;
  Steinberg::IPtr<Handler> handler;
  Steinberg::IPtr<Frame> frame;
  Steinberg::IPtr<Steinberg::IPlugView> view;
  std::unique_ptr<NativeWindow> window;
  Steinberg::Vst::HostProcessData data;
  Steinberg::Vst::ParameterChanges inputs{4096},outputs{4096};
  Steinberg::Vst::EventList inputEvents{128},outputEvents{128};
  std::atomic<int> restartFlags{0};
  std::atomic<bool> dirty{false};
  std::atomic<bool> editorRequested{false};
  bool closeRequested=false,resizing=false,active=false,processing=false;
  int precision=0,maxBlock=512;
  double rate=48000;
  Event emit;
public:
  const std::string instanceId,path,classId;
  std::string name;
  bool bypassed=false;
  uint32_t latency=0;
  uint32_t tail=0;
  Plugin(const Json&,Steinberg::FUnknown*,Event);
  ~Plugin();
  void configure(double,int);
  void flush();
  void flushParameters();
  void process(float*,int,Steinberg::Vst::ProcessContext&);
  void openEditor(bool);
  void closeEditor();
  void pump();
  Json getState();
  void setState(const Json&);
  Json getParameters();
  void setParameter(uint32_t,double);
  void stop();
};
Json scan(const std::string&,Steinberg::FUnknown*);
}
