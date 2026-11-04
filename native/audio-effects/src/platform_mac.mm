#include "platform.h"
#include "pluginterfaces/gui/iplugview.h"
#import <Cocoa/Cocoa.h>

@interface BKEditorDelegate : NSObject <NSWindowDelegate>
@property(nonatomic) bk::WindowCallbacks* callbacks;
@end
@implementation BKEditorDelegate
- (BOOL)windowShouldClose:(NSWindow*)window { [window orderOut:nil]; if(self.callbacks) self.callbacks->close(); return NO; }
- (void)windowDidResize:(NSNotification*)note {
  NSWindow* window=note.object;NSSize size=window.contentView.bounds.size;
  if(self.callbacks) self.callbacks->resize((int)size.width,(int)size.height);
}
@end

namespace bk {
class MacWindow final : public NativeWindow {
  NSWindow* window;
  BKEditorDelegate* delegate;
  WindowCallbacks callbacks;
public:
  MacWindow(const std::string& title,int w,int h,WindowCallbacks c):callbacks(std::move(c)) {
    window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,w,h) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed=NO;window.title=[NSString stringWithUTF8String:title.c_str()];
    delegate=[BKEditorDelegate new];delegate.callbacks=&callbacks;window.delegate=delegate;[window center];
  }
  ~MacWindow() override {delegate.callbacks=nullptr;window.delegate=nil;[window close];}
  void* handle() const override {return (__bridge void*)window.contentView;}
  const char* type() const override {return Steinberg::kPlatformTypeNSView;}
  void show(bool top) override {window.level=top?NSFloatingWindowLevel:NSNormalWindowLevel;[window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];}
  void resize(int w,int h) override {[window setContentSize:NSMakeSize(w,h)];}
};
void platformInit(){[NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];[NSApp finishLaunching];}
void platformPump(){@autoreleasepool {for(int i=0;i<64;i++){NSEvent* event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate distantPast] inMode:NSDefaultRunLoopMode dequeue:YES];if(!event)break;[NSApp sendEvent:event];}[NSApp updateWindows];}}
void platformShutdown(){}
Steinberg::FUnknown* platformRunLoop(){return nullptr;}
std::unique_ptr<NativeWindow> createWindow(const std::string& title,int w,int h,WindowCallbacks c){return std::make_unique<MacWindow>(title,w,h,std::move(c));}
}
