param([long]$OwnerWindow, [int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase

# Only the supplied, PID-checked application window is modified. Explorer windows and
# their controls are read for geometry; no taskbar settings, styles or positions change.
Add-Type -ReferencedAssemblies @('System.dll', [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class BKTaskbar {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  public class Box { public int x, y, width, height; public Box(RECT r) { x=r.Left; y=r.Top; width=r.Right-r.Left; height=r.Bottom-r.Top; } }
  public class Bar { public string handle, edge; public Box bounds, monitor; public bool visible, hidden, reliable; public List<Box> occupied = new List<Box>(); }
  public class Placement { public bool embedded; public string warning; }
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int length);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr child);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetStyle(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] static extern int SetStyle(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  static IntPtr owner, originalParent;
  static uint ownerPid;
  static int originalStyle;
  static bool attached;
  static HashSet<IntPtr> knownBars = new HashSet<IntPtr>();
  sealed class SampleJob { public Thread Thread; public List<Bar> Result; public bool Failed; }
  static SampleJob sampling;
  public static string SampleWarning { get; private set; }
  static string Kind(IntPtr hwnd) { var value = new StringBuilder(128); GetClassName(hwnd,value,value.Capacity); return value.ToString(); }
  static bool IsBar(IntPtr hwnd) { string kind=Kind(hwnd); return kind=="Shell_TrayWnd" || kind=="Shell_SecondaryTrayWnd"; }
  static void AssertOwner() { uint pid; GetWindowThreadProcessId(owner,out pid); if (!IsWindow(owner) || pid!=ownerPid) throw new InvalidOperationException("Lyric window is no longer owned by this process"); }
  public static void Initialize(long hwnd, int pid) { owner=new IntPtr(hwnd); ownerPid=(uint)pid; if(hwnd==0) return; AssertOwner(); originalParent=GetParent(owner); originalStyle=GetStyle(owner,-16); }
  public static List<Bar> Sample() {
    // Only this protocol thread may authorize taskbar HWNDs. A late UIA result
    // cannot restore an expired whitelist or block apply/detach/EXIT commands.
    knownBars.Clear(); SampleWarning="";
    if(sampling!=null) {
      if(sampling.Thread.IsAlive) { SampleWarning="sampling-timeout"; return new List<Bar>(); }
      sampling=null;
    }
    var job=new SampleJob();
    job.Thread=new Thread(delegate() {
      try { job.Result=SampleCore(); } catch { job.Failed=true; }
    });
    job.Thread.IsBackground=true;
    job.Thread.SetApartmentState(ApartmentState.MTA);
    sampling=job;
    job.Thread.Start();
    if(!job.Thread.Join(700)) { SampleWarning="sampling-timeout"; return new List<Bar>(); }
    sampling=null;
    if(job.Failed || job.Result==null) { SampleWarning="sampling-failed"; return new List<Bar>(); }
    foreach(var bar in job.Result) if(!bar.hidden) knownBars.Add(new IntPtr(Int64.Parse(bar.handle)));
    return job.Result;
  }
  // Geometry does not need UI Automation. Re-read it after a UIA timeout so a
  // hidden bar cannot be mistaken for a missing one and replaced by a floating lyric.
  public static List<Bar> ReadBars() {
    IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    if(previous==IntPtr.Zero) previous=SetThreadDpiAwarenessContext(new IntPtr(-3));
    var result=new List<Bar>();
    try {
      EnumWindows(delegate(IntPtr hwnd,IntPtr unused) {
        if (!IsBar(hwnd)) return true;
        RECT rect; if(!GetWindowRect(hwnd,out rect)) return true;
        MONITORINFO info=new MONITORINFO(); info.Size=Marshal.SizeOf(typeof(MONITORINFO));
        if(!GetMonitorInfo(MonitorFromWindow(hwnd,2),ref info)) return true;
        var bar=new Bar { handle=hwnd.ToInt64().ToString(), bounds=new Box(rect), monitor=new Box(info.Monitor), visible=IsWindowVisible(hwnd) };
        bar.edge=rect.Right-rect.Left >= rect.Bottom-rect.Top ? (rect.Top < info.Monitor.Top+(info.Monitor.Bottom-info.Monitor.Top)/2 ? "top":"bottom") : (rect.Left < info.Monitor.Left+(info.Monitor.Right-info.Monitor.Left)/2 ? "left":"right");
        bool horizontal=bar.edge=="top" || bar.edge=="bottom";
        // WS_VISIBLE can remain set while Explorer slides most of the HWND off-screen.
        // Also treat a window shrunk to the thin reveal strip as hidden.
        bar.hidden=!bar.visible || (horizontal
          ? bar.bounds.height<=4 || rect.Top<info.Monitor.Top || rect.Bottom>info.Monitor.Bottom
          : bar.bounds.width<=4 || rect.Left<info.Monitor.Left || rect.Right>info.Monitor.Right);
        result.Add(bar); return true;
      },IntPtr.Zero);
      return result;
    } finally { if(previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  static List<Bar> SampleCore() {
    IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    if(previous==IntPtr.Zero) previous=SetThreadDpiAwarenessContext(new IntPtr(-3));
    try {
      var result=ReadBars();
      foreach(var bar in result) {
        if(bar.hidden) continue;
        IntPtr hwnd=new IntPtr(Int64.Parse(bar.handle));
        // Tray, clock and start controls are protected even if UI Automation is incomplete.
        EnumChildWindows(hwnd,delegate(IntPtr child,IntPtr ignored) {
          string kind=Kind(child); RECT childRect;
          if(IsWindowVisible(child) && (kind=="TrayNotifyWnd" || kind=="TrayClockWClass" || kind=="Start" || kind=="TrayShowDesktopButtonWClass") && GetWindowRect(child,out childRect)) bar.occupied.Add(new Box(childRect));
          return true;
        },IntPtr.Zero);
        try {
          var root=AutomationElement.FromHandle(hwnd);
          var condition=new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button),new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem));
          var controls=root.FindAll(TreeScope.Descendants,condition);
          for(int i=0;i<Math.Min(controls.Count,512);i++) {
            var current=controls[i].Current;
            if(current.IsOffscreen || current.ProcessId==ownerPid) continue;
            var box=current.BoundingRectangle;
            if(box.IsEmpty || box.Width<=0 || box.Height<=0 || box.Width>bar.bounds.width*0.9) continue;
            bar.occupied.Add(new Box(new RECT {Left=(int)Math.Floor(box.Left),Top=(int)Math.Floor(box.Top),Right=(int)Math.Ceiling(box.Right),Bottom=(int)Math.Ceiling(box.Bottom)}));
          }
          bar.reliable=controls.Count>0 && controls.Count<=512;
        } catch { bar.reliable=false; }
      }
      return result;
    } finally { if(previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  // Hide only our window without changing its taskbar parent, coordinates or Z order.
  public static void Hide() {
    AssertOwner();
    if(!SetWindowPos(owner,IntPtr.Zero,0,0,0,0,0x0001|0x0002|0x0004|0x0010|0x0080)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Detach() {
    IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    if(previous==IntPtr.Zero) previous=SetThreadDpiAwarenessContext(new IntPtr(-3));
    try { DetachCore(); } finally { if(previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  static void DetachCore() {
    if(!attached) return;
    AssertOwner();
    SetLastError(0); SetParent(owner,IsWindow(originalParent)?originalParent:IntPtr.Zero);
    int error=Marshal.GetLastWin32Error(); if(error!=0) throw new System.ComponentModel.Win32Exception(error);
    SetStyle(owner,-16,originalStyle);
    attached=false;
    SetWindowPos(owner,new IntPtr(-1),0,0,0,0,0x0001|0x0002|0x0010|0x0020);
  }
  public static Placement Apply(string parentValue, bool embed, int x,int y,int width,int height,bool visible) {
    IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    if(previous==IntPtr.Zero) previous=SetThreadDpiAwarenessContext(new IntPtr(-3));
    try { return ApplyCore(parentValue,embed,x,y,width,height,visible); } finally { if(previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
  static Placement ApplyCore(string parentValue, bool embed, int x,int y,int width,int height,bool visible) {
    AssertOwner(); var result=new Placement(); bool changed=false;
    IntPtr parent=new IntPtr(Int64.Parse(parentValue));
    if(embed && (!knownBars.Contains(parent) || !IsWindow(parent) || !IsBar(parent))) { embed=false; result.warning="taskbar-missing"; }
    if(embed && !AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(owner),GetWindowDpiAwarenessContext(parent))) { embed=false; result.warning="dpi-mismatch"; }
    if(!embed) Detach();
    if(embed && GetParent(owner)!=parent) {
      if(attached) Detach();
      SetStyle(owner,-16,(originalStyle & ~unchecked((int)0x80C40000)) | 0x40000000);
      SetLastError(0); SetParent(owner,parent); int error=Marshal.GetLastWin32Error();
      if(error!=0 || GetParent(owner)!=parent) {
        attached=GetParent(owner)!=originalParent;
        if(attached) Detach(); else SetStyle(owner,-16,originalStyle);
        embed=false; result.warning="embed-failed";
      } else { attached=true; changed=true; }
    }
    if(!embed) return result;
    POINT position=new POINT {X=x,Y=y};
    if(embed && !ScreenToClient(parent,ref position)) throw new InvalidOperationException("Taskbar coordinates unavailable");
    uint flags=0x0010|(changed?0x0020u:0)|(visible?0x0040u:0x0080u);
    if(!SetWindowPos(owner,embed?IntPtr.Zero:new IntPtr(-1),position.X,position.Y,width,height,flags)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    result.embedded=embed; return result;
  }
}
'@

try {
  [BKTaskbar]::Initialize($OwnerWindow, $OwnerProcessId)
  [Console]::Out.WriteLine('{"ready":true}')
  [Console]::Out.Flush()
  while (($line = [Console]::ReadLine()) -ne $null) {
    if ($line -eq 'EXIT') { break }
    if ($line.Length -gt 4096) { throw 'Invalid taskbar request' }
    $request = $line | ConvertFrom-Json
    try {
      if ($request.command -eq 'sample') {
        $dark = $true
        $theme = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name SystemUsesLightTheme -ErrorAction SilentlyContinue
        if ($null -ne $theme) { $dark = $theme.SystemUsesLightTheme -eq 0 }
        $bars = @([BKTaskbar]::Sample())
        if ([BKTaskbar]::SampleWarning) { $bars = @([BKTaskbar]::ReadBars()) }
        $response = @{ id=$request.id; ok=$true; bars=$bars; dark=$dark; warning=[BKTaskbar]::SampleWarning }
      } elseif ($request.command -eq 'apply') {
        $placement = [BKTaskbar]::Apply([string]$request.parent, [bool]$request.embed, [int]$request.x, [int]$request.y, [int]$request.width, [int]$request.height, [bool]$request.visible)
        $response = @{ id=$request.id; ok=$true; embedded=$placement.embedded; warning=$placement.warning }
      } elseif ($request.command -eq 'hide') {
        [BKTaskbar]::Hide()
        $response = @{ id=$request.id; ok=$true }
      } elseif ($request.command -eq 'detach') {
        [BKTaskbar]::Detach()
        $response = @{ id=$request.id; ok=$true }
      } else { throw 'Unknown taskbar request' }
    } catch { $response = @{ id=$request.id; ok=$false; error=$_.Exception.Message } }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 8 -Compress))
    [Console]::Out.Flush()
  }
} finally { [BKTaskbar]::Detach() }
