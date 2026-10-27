using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class LaunchConfig {
  public string name { get; set; }
  public string runtimeExe { get; set; }
  public string[] runtimeArgs { get; set; }
  public Dictionary<string,string> environment { get; set; }
  public int maxWaitSeconds { get; set; }
}
public static class NativeLauncher {
  static string GetScratchRoot() {
    string value=Environment.GetEnvironmentVariable("KRAB_SCRATCH_ROOT");
    if(value==null) {
      string local=Environment.GetEnvironmentVariable("LOCALAPPDATA");
      if(String.IsNullOrEmpty(local)) throw new IOException("LOCALAPPDATA or KRAB_SCRATCH_ROOT is required.");
      value=Path.Combine(local,@"KRAB\scratch");
    }
    if(!System.Text.RegularExpressions.Regex.IsMatch(value,@"^[a-zA-Z]:[\\/]") || value.Substring(2).Contains(":")) throw new IOException("Scratch root must be an absolute local directory.");
    string result=Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
    if(result.Length<=2) throw new IOException("A drive root cannot be a scratch directory.");
    return result;
  }
  static void SafeAncestors(string value) {
    for (string p=Path.GetFullPath(value); !String.IsNullOrEmpty(p); p=Path.GetDirectoryName(p)) {
      if ((Directory.Exists(p) || File.Exists(p)) && (File.GetAttributes(p) & FileAttributes.ReparsePoint)!=0) throw new IOException("Redirected launch path refused: "+p);
    }
  }
  static string InPackage(string root,string relative) {
    if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative)) throw new IOException("Runtime and runner paths must be relative to this package.");
    string result=Path.GetFullPath(Path.Combine(root,relative));
    if (!result.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new IOException("Path escaped the package.");
    SafeAncestors(result);
    if(!File.Exists(result)) throw new FileNotFoundException("Package file missing",result);
    return result;
  }
  [STAThread] public static int Main(string[] extra) {
    string launcherRun=null;
    try {
      string root=AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
      var json=new JavaScriptSerializer();
      var config=json.Deserialize<LaunchConfig>(File.ReadAllText(InPackage(root,"launch.json")));
      string runtime=InPackage(root,config.runtimeExe);
      string runner=InPackage(root,@"runner\Run-WithScratch.ps1");
      int wait=config.maxWaitSeconds==0?86400:config.maxWaitSeconds;
      if(wait<1 || wait>86400) throw new IOException("Invalid maximum run time.");
      string ScratchRoot=GetScratchRoot();
      SafeAncestors(ScratchRoot); Directory.CreateDirectory(ScratchRoot);
      launcherRun=Path.Combine(ScratchRoot,"native-launcher-"+Guid.NewGuid().ToString("N"));
      if(Directory.Exists(launcherRun)) throw new IOException("Launcher directory already exists.");
      Directory.CreateDirectory(launcherRun); string temp=Path.Combine(launcherRun,"temp"); Directory.CreateDirectory(temp);
      var arguments=new List<string>();
      foreach(string arg in config.runtimeArgs??new string[0]) arguments.Add(arg.Replace("{PACKAGE}",root));
      bool validate=extra.Length==1 && extra[0]=="--validate-launcher";
      if(!validate) arguments.AddRange(extra);
      var payload=new {wrapper=runner, executable=runtime, args=arguments.ToArray(), cwd=Path.GetDirectoryName(runtime), wait=wait};
      File.WriteAllText(Path.Combine(launcherRun,"launch-receipt.json"),json.Serialize(new {schema=1, name=config.name, package=root, runtime=runtime, launcherTemp=temp, validationOnly=validate, created=DateTime.UtcNow.ToString("o")}));
      if(validate) return 0;
      string data=Convert.ToBase64String(Encoding.UTF8.GetBytes(json.Serialize(payload)));
      string ps="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"')) | ConvertFrom-Json; $r=& $d.wrapper -FilePath $d.executable -ArgumentList @($d.args) -WorkingDirectory $d.cwd -RunKind portable-test -MaxWaitSeconds $d.wait; $r | ConvertTo-Json -Compress; if($r.Status -ne 'Succeeded'){if($null -ne $r.ExitCode -and $r.ExitCode -ne 0 -and $r.ExitCode -le 2147483647){exit [int]$r.ExitCode};exit 1}";
      var start=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(ps)));
      start.UseShellExecute=false; start.CreateNoWindow=true; start.WindowStyle=ProcessWindowStyle.Hidden; start.RedirectStandardOutput=true; start.RedirectStandardError=true;
      start.EnvironmentVariables["KRAB_SCRATCH_ROOT"]=ScratchRoot;
      start.EnvironmentVariables["TEMP"]=temp; start.EnvironmentVariables["TMP"]=temp;
      // This entry launches a GUI runtime. Drop inherited Node mode in the child only.
      start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
      // Do not inherit a stale managed context from a shell that launched another build.
      foreach(string key in new[]{"EDENA_SCRATCH_MANAGED","EDENA_SCRATCH_RUN","EDENA_SCRATCH_TEMP","EDENA_ARTIFACTS_DIR"}) start.EnvironmentVariables.Remove(key);
      foreach(var item in config.environment??new Dictionary<string,string>()) {
        if(!(item.Key.StartsWith("FIELD_",StringComparison.Ordinal)||item.Key.StartsWith("MOSHPIT_",StringComparison.Ordinal)||item.Key.StartsWith("WAXYCT_",StringComparison.Ordinal))) throw new IOException("Unsupported application environment key: "+item.Key);
        start.EnvironmentVariables[item.Key]=item.Value.Replace("{PACKAGE}",root);
      }
      using(var process=new Process()) {
        process.StartInfo=start; process.Start();
        var stdout=process.StandardOutput.ReadToEndAsync(); var stderr=process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        File.WriteAllText(Path.Combine(launcherRun,"runner-output.log"),stdout.Result);
        File.WriteAllText(Path.Combine(launcherRun,"runner-error.log"),stderr.Result);
        if(process.ExitCode!=0) throw new IOException("The application or launch tracking reported a problem. Nothing was killed; temporary files were preserved. See "+launcherRun);
      }
      // Launcher-only temp is outside the child job: retain it conservatively.
      return 0;
    } catch(Exception error) {
      if(launcherRun!=null) File.WriteAllText(Path.Combine(launcherRun,"ERROR.txt"),error.ToString());
      MessageBox.Show(error.Message,"Application launch",MessageBoxButtons.OK,MessageBoxIcon.Error); return 1;
    }
  }
}
