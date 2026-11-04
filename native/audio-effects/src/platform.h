#pragma once
#include <functional>
#include <memory>
#include <string>
#include "pluginterfaces/base/funknown.h"

namespace bk {
struct WindowCallbacks {
  std::function<void()> close;
  std::function<void(int,int)> resize;
};
class NativeWindow {
public:
  virtual ~NativeWindow() = default;
  virtual void* handle() const = 0;
  virtual const char* type() const = 0;
  virtual void show(bool alwaysOnTop) = 0;
  virtual void resize(int width, int height) = 0;
};
void platformInit();
void platformPump();
void platformShutdown();
Steinberg::FUnknown* platformRunLoop();
std::unique_ptr<NativeWindow> createWindow(const std::string&, int, int, WindowCallbacks);
}
