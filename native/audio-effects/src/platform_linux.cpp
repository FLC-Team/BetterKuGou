#include "platform.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/base/funknownimpl.h"
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <poll.h>
#include <map>
#include <vector>
#include <chrono>
#include <algorithm>
#include <stdexcept>

namespace bk {
using namespace Steinberg;
static Display* display=nullptr;
class XWindow;
static std::map<::Window,XWindow*> windows;
class RunLoop final:public U::Implements<U::Directly<Linux::IRunLoop>> {
  struct Timer{IPtr<Linux::ITimerHandler> handler;uint64 interval,next;};
  std::map<int,IPtr<Linux::IEventHandler>> events;
  std::vector<Timer> timers;
  static uint64 now(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();}
public:
  tresult PLUGIN_API registerEventHandler(Linux::IEventHandler* h, int fd) override {if(!h||fd<0)return kInvalidArgument;events[fd]=h;return kResultOk;}
  tresult PLUGIN_API unregisterEventHandler(Linux::IEventHandler* h) override {for(auto i=events.begin();i!=events.end();)if(i->second.get()==h)i=events.erase(i);else ++i;return kResultOk;}
  tresult PLUGIN_API registerTimer(Linux::ITimerHandler* h,uint64 ms) override {if(!h||!ms)return kInvalidArgument;timers.push_back({h,ms,now()+ms});return kResultOk;}
  tresult PLUGIN_API unregisterTimer(Linux::ITimerHandler* h) override {timers.erase(std::remove_if(timers.begin(),timers.end(),[h](const Timer&t){return t.handler.get()==h;}),timers.end());return kResultOk;}
  void pump(){auto copy=events;for(auto&[fd,h]:copy){pollfd p{fd,POLLIN,0};if(poll(&p,1,0)>0&&events.count(fd))h->onFDIsSet(fd);}auto due=timers;for(auto&t:due)if(now()>=t.next){auto live=std::find_if(timers.begin(),timers.end(),[&](const Timer& entry){return entry.handler.get()==t.handler.get();});if(live!=timers.end()){live->next=now()+live->interval;t.handler->onTimer();}}}
};
static IPtr<RunLoop> runLoop;
class XWindow final:public NativeWindow {
  ::Window window;
  Atom closeProtocol;
  WindowCallbacks callbacks;
public:
  XWindow(const std::string& title,int w,int h,WindowCallbacks c):callbacks(std::move(c)) {
    if(!display)throw std::runtime_error("VST3 editor requires X11/XWayland display");
    window=XCreateSimpleWindow(display,DefaultRootWindow(display),100,100,w,h,0,0,0);
    XStoreName(display,window,title.c_str());closeProtocol=XInternAtom(display,"WM_DELETE_WINDOW",False);XSetWMProtocols(display,window,&closeProtocol,1);
    XSelectInput(display,window,StructureNotifyMask|ExposureMask);windows[window]=this;
  }
  ~XWindow(){windows.erase(window);XDestroyWindow(display,window);XFlush(display);}
  void event(const XEvent&e){if(e.type==ClientMessage&&Atom(e.xclient.data.l[0])==closeProtocol){XUnmapWindow(display,window);callbacks.close();}else if(e.type==ConfigureNotify)callbacks.resize(e.xconfigure.width,e.xconfigure.height);}
  void* handle() const override{return reinterpret_cast<void*>(window);}
  const char* type() const override{return kPlatformTypeX11EmbedWindowID;}
  void show(bool top) override {Atom above=XInternAtom(display,"_NET_WM_STATE_ABOVE",False);Atom state=XInternAtom(display,"_NET_WM_STATE",False);if(top)XChangeProperty(display,window,state,XA_ATOM,32,PropModeReplace,reinterpret_cast<unsigned char*>(&above),1);else XDeleteProperty(display,window,state);XMapRaised(display,window);XFlush(display);}
  void resize(int w,int h) override{XResizeWindow(display,window,w,h);XFlush(display);}
};
void platformInit(){XInitThreads();display=XOpenDisplay(nullptr);runLoop=owned(new RunLoop);}
void platformPump(){if(display)while(XPending(display)){XEvent e;XNextEvent(display,&e);auto i=windows.find(e.xany.window);if(i!=windows.end())i->second->event(e);}runLoop->pump();}
void platformShutdown(){runLoop=nullptr;if(display)XCloseDisplay(display);display=nullptr;}
FUnknown* platformRunLoop(){return runLoop;}
std::unique_ptr<NativeWindow> createWindow(const std::string& title,int w,int h,WindowCallbacks c){return std::make_unique<XWindow>(title,w,h,std::move(c));}
}
