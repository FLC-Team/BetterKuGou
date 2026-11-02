const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')
const { createWindowsTaskbarBridge } = require('../electron/services/windowsTaskbar')

const scriptPath = path.join(__dirname, '../electron/services/windowsTaskbar.ps1')
const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const windowsOnly = { skip: process.platform !== 'win32', timeout: 30000 }

/** Compile the shipped sampling wrapper; only its external UI Automation work is replaced. */
function controlledSamplingSource() {
  const script = fs.readFileSync(scriptPath, 'utf8')
  const definition = script.match(/-TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)
  assert.ok(definition, 'the shipped helper must contain its C# definition')
  const signature = /static List<Bar> SampleCore\(\)\s*\{/
  assert.match(definition[1], signature)
  const source = definition[1].replace(signature, 'static List<Bar> UncalledSampleCore() {')
    .replace(/\}\s*$/, '  static List<Bar> SampleCore() { return SamplingProbe.Read(); }\n}')
  return source + `
public static class SamplingProbe {
  static readonly ManualResetEvent Release = new ManualResetEvent(false);
  static int calls;
  static HashSet<IntPtr> Known {
    get { return (HashSet<IntPtr>)typeof(BKTaskbar).GetField("knownBars", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static).GetValue(null); }
  }
  static void Check(bool value, string message) { if(!value) throw new InvalidOperationException(message); }
  static List<BKTaskbar.Bar> One(int handle) { return new List<BKTaskbar.Bar> { new BKTaskbar.Bar { handle=handle.ToString() } }; }
  public static List<BKTaskbar.Bar> Read() {
    int call=Interlocked.Increment(ref calls);
    Check(Thread.CurrentThread.IsBackground, "sampling must not keep the helper alive");
    Check(Thread.CurrentThread.GetApartmentState()==ApartmentState.MTA, "UI Automation must run in MTA");
    if(call==2) Release.WaitOne();
    if(call==4) throw new InvalidOperationException("controlled UI Automation failure");
    return One(call*101);
  }
  public static string Run() {
    var seeded=BKTaskbar.Sample();
    Check(seeded.Count==1 && seeded[0].handle=="101" && Known.SetEquals(new[] {new IntPtr(101)}), "a fresh completed sample authorizes its handle");
    var watch=System.Diagnostics.Stopwatch.StartNew();
    var stalled=BKTaskbar.Sample();
    watch.Stop();
    Check(watch.ElapsedMilliseconds<2500, "blocked UI Automation exceeded the bounded sample response");
    Check(stalled.Count==0 && BKTaskbar.SampleWarning=="sampling-timeout", "a stalled sample must return an explicit empty fallback");
    Check(Known.Count==0, "a timeout must revoke previously authorized taskbars");
    var job=typeof(BKTaskbar).GetField("sampling", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static).GetValue(null);
    Check(job!=null, "the pending sample must remain owned");
    var worker=(Thread)job.GetType().GetField("Thread").GetValue(job);
    Check(worker.IsAlive && worker.IsBackground && worker.GetApartmentState()==ApartmentState.MTA, "the single pending worker must be a background MTA thread");
    for(int index=0;index<4;index++) {
      Check(BKTaskbar.Sample().Count==0 && BKTaskbar.SampleWarning=="sampling-timeout", "polls while stalled must retain the explicit fallback");
      Check(calls==2, "polling must not spawn additional blocked workers");
    }
    Release.Set();
    Check(worker.Join(5000), "the controlled old worker should finish after release");
    Check(Known.Count==0, "a late result must not restore an expired taskbar whitelist");
    var fresh=BKTaskbar.Sample();
    Check(calls==3 && fresh.Count==1 && fresh[0].handle=="303", "recovery must take a fresh sample instead of consuming the late one");
    Check(BKTaskbar.SampleWarning=="" && Known.SetEquals(new[] {new IntPtr(303)}), "only the new successful sample may restore authorized handles");
    var failed=BKTaskbar.Sample();
    Check(failed.Count==0 && BKTaskbar.SampleWarning=="sampling-failed" && Known.Count==0, "an exception must clear stale geometry and report a retryable failure");
    var recovered=BKTaskbar.Sample();
    Check(calls==5 && recovered.Count==1 && recovered[0].handle=="505", "an exception must allow a subsequent sample to recover");
    Check(BKTaskbar.SampleWarning=="" && Known.SetEquals(new[] {new IntPtr(505)}), "recovery must clear the failure and use only fresh handles");
    return "bounded-single-flight-recovery-ok";
  }
}
`
}

/** Feed the large source over stdin so this test also respects Windows' command-line limit. */
function runSamplingProbe(source) {
  const command = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
Add-Type -ReferencedAssemblies @('System.dll', [System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location) -TypeDefinition $source
[Console]::Out.WriteLine([SamplingProbe]::Run())`
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536 }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout, stderr })
      })
    child.stdin.on('error', reject)
    child.stdin.end(Buffer.from(source, 'utf8').toString('base64') + '\n')
  })
}

test('real native sampling wrapper bounds blocked UIA, keeps one worker and rejects late authorization', windowsOnly, async () => {
  const result = await runSamplingProbe(controlledSamplingSource())
  assert.equal(result.stderr.trim(), '')
  assert.equal(result.stdout.trim(), 'bounded-single-flight-recovery-ok')
})

test('a permanently blocked native sampler still responds to sample, detach and orderly EXIT', windowsOnly, async t => {
  const script = fs.readFileSync(scriptPath, 'utf8')
  const signature = /static List<Bar> SampleCore\(\)\s*\{/
  assert.match(script, signature)
  const blocked = script.replace(signature, '$&\n    Thread.Sleep(Timeout.Infinite);')
  const errors = [], exits = []
  let kills = 0
  const bridge = createWindowsTaskbarBridge({ scriptPath, handle: Buffer.alloc(8), readScript: () => blocked,
    onError: error => errors.push(error),
    spawnProcess(...args) {
      const child = spawn(...args)
      const kill = child.kill.bind(child)
      child.kill = (...values) => { kills++; return kill(...values) }
      child.once('exit', code => exits.push(code))
      return child
    } })
  // This fixture never owns an HWND; even a failing assertion must release its helper.
  t.after(() => bridge.stop({ ownerDestroyed: true }))
  await bridge.start()
  for (let index = 0; index < 3; index++) {
    const result = await bridge.request('sample')
    assert.equal(result.ok, true)
    assert.deepEqual(result.bars, [])
    assert.equal(result.warning, 'sampling-timeout')
    assert.equal(typeof result.dark, 'boolean')
  }
  assert.equal((await bridge.request('detach')).ok, true)
  await bridge.stop()
  assert.deepEqual(exits, [0], 'EXIT must complete while the background sampling thread remains blocked')
  assert.equal(kills, 0, 'the protocol thread must reach its detach finally block without forced termination')
  assert.deepEqual(errors, [])
})
