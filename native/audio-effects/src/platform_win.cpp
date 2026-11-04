#include "platform.h"
#include "pluginterfaces/gui/iplugview.h"
#include <windows.h>
#include <stdexcept>

namespace bk {
class WinWindow final : public NativeWindow {
  HWND hwnd = nullptr;
  WindowCallbacks callbacks;
public:
  static LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
    auto* self = reinterpret_cast<WinWindow*>(GetWindowLongPtrW(hwnd,GWLP_USERDATA));
    if(message==WM_NCCREATE) {
      self=static_cast<WinWindow*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
      SetWindowLongPtrW(hwnd,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(self));
    }
    if(self && message==WM_CLOSE) { ShowWindow(hwnd,SW_HIDE); self->callbacks.close(); return 0; }
    if(self && message==WM_SIZE && w!=SIZE_MINIMIZED) self->callbacks.resize(LOWORD(l),HIWORD(l));
    return DefWindowProcW(hwnd,message,w,l);
  }
public:
  WinWindow(const std::string& title,int width,int height,WindowCallbacks c):callbacks(std::move(c)) {
    int size=MultiByteToWideChar(CP_UTF8,0,title.c_str(),-1,nullptr,0);
    std::wstring text(size,L'\0'); MultiByteToWideChar(CP_UTF8,0,title.c_str(),-1,text.data(),size);
    hwnd=CreateWindowExW(WS_EX_APPWINDOW,L"BK.VST3.Editor",text.c_str(),WS_OVERLAPPEDWINDOW|WS_CLIPCHILDREN,
      CW_USEDEFAULT,CW_USEDEFAULT,width,height,nullptr,nullptr,GetModuleHandleW(nullptr),this);
    if(!hwnd) throw std::runtime_error("Cannot create plug-in editor window");
    resize(width,height);
  }
  ~WinWindow() override { if(hwnd) {SetWindowLongPtrW(hwnd,GWLP_USERDATA,0);DestroyWindow(hwnd);} }
  void* handle() const override {return hwnd;}
  const char* type() const override {return Steinberg::kPlatformTypeHWND;}
  // ShowWindow's first call can inherit SW_HIDE from Node's windowsHide startup
  // info. SWP_SHOWWINDOW explicitly shows each user-requested editor instead.
  void show(bool top) override {SetWindowPos(hwnd,top?HWND_TOPMOST:HWND_NOTOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW);if(!IsWindowVisible(hwnd))throw std::runtime_error("Native editor window could not be shown");SetForegroundWindow(hwnd);}
  void resize(int width,int height) override {
    RECT rect{0,0,width,height};AdjustWindowRectEx(&rect,GetWindowLongW(hwnd,GWL_STYLE),FALSE,GetWindowLongW(hwnd,GWL_EXSTYLE));
    SetWindowPos(hwnd,nullptr,0,0,rect.right-rect.left,rect.bottom-rect.top,SWP_NOMOVE|SWP_NOZORDER|SWP_NOACTIVATE);
  }
};
void platformInit() {
  CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
  // Each editor remains a native top-level window; plug-in DPI callbacks receive its actual scale.
  SetProcessDPIAware();
  WNDCLASSW wc{};wc.lpfnWndProc=WinWindow::procedure;wc.hInstance=GetModuleHandleW(nullptr);
  wc.lpszClassName=L"BK.VST3.Editor";wc.hCursor=LoadCursorW(nullptr,IDC_ARROW);wc.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_WINDOW+1);
  RegisterClassW(&wc);
}
void platformPump() {MSG msg;while(PeekMessageW(&msg,nullptr,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}}
void platformShutdown(){CoUninitialize();}
Steinberg::FUnknown* platformRunLoop(){return nullptr;}
std::unique_ptr<NativeWindow> createWindow(const std::string& title,int w,int h,WindowCallbacks callbacks) {
  return std::make_unique<WinWindow>(title,w,h,std::move(callbacks));
}
}
