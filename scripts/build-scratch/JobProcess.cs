using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Threading;

namespace EdenaScratch {
  public sealed class Result {
    public int ProcessId;
    public uint ExitCode;
    public bool AllExited;
    public bool TimedOut;
    public string Error;
  }
  public static class JobProcess {
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
      public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING {
      public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BASIC_ACCOUNTING info, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttr, IntPtr threadAttr, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO start, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint millis);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint sharing, ref SECURITY_ATTRIBUTES attrs, uint disposition, uint flags, IntPtr template);
    static readonly IntPtr Invalid = new IntPtr(-1);
    static Exception Error(string message) { return new Win32Exception(Marshal.GetLastWin32Error(), message); }
    static string Quote(string value) {
      var output = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append('"'); slashes = 0; continue; }
        output.Append('\\', slashes); slashes = 0; output.Append(c);
      }
      output.Append('\\', slashes * 2); return output.Append('"').ToString();
    }
    public static Result Run(string exe, string[] args, string cwd, string stdout, string stderr, int maxSeconds) {
      IntPtr job = IntPtr.Zero, output = Invalid, error = Invalid, input = Invalid;
      var pi = new PROCESS_INFORMATION(); var result = new Result(); bool resumed = false;
      try {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Error("CreateJobObject failed");
        // Deliberately no KILL_ON_JOB_CLOSE, BREAKAWAY_OK or SILENT_BREAKAWAY_OK.
        // Detached descendants stay in the job; closing this handle cannot kill them.
        var attrs = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 1 };
        output = CreateFile(stdout, 0x40000000, 3, ref attrs, 1, 0x80, IntPtr.Zero);
        error = CreateFile(stderr, 0x40000000, 3, ref attrs, 1, 0x80, IntPtr.Zero);
        input = CreateFile("NUL", 0x80000000, 3, ref attrs, 3, 0x80, IntPtr.Zero);
        if (output == Invalid || error == Invalid || input == Invalid) throw Error("Create log handles failed");
        var start = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x100, hStdOutput = output, hStdError = error, hStdInput = input };
        var command = new StringBuilder(Quote(exe)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        // TEMP/TMP have already been scoped to this invocation by the PowerShell caller.
        if (!CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, 0x00000004 | 0x08000000, IntPtr.Zero, cwd, ref start, out pi)) throw Error("CreateProcess failed");
        result.ProcessId = (int)pi.dwProcessId;
        if (!AssignProcessToJobObject(job, pi.hProcess)) throw Error("AssignProcessToJobObject failed; no safe tree tracking");
        if (ResumeThread(pi.hThread) == 0xffffffff) throw Error("ResumeThread failed");
        resumed = true;
        var clock = Stopwatch.StartNew();
        while (true) {
          BASIC_ACCOUNTING info;
          if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), IntPtr.Zero)) throw Error("QueryInformationJobObject failed");
          if (info.ActiveProcesses == 0) {
            // Accounting may reach zero just before the root handle becomes signaled.
            // Keep waiting within the same overall timeout; never infer completion.
            uint signaled = WaitForSingleObject(pi.hProcess, 100);
            if (signaled == 0) {
              uint code; if (!GetExitCodeProcess(pi.hProcess, out code)) throw Error("GetExitCodeProcess failed");
              result.ExitCode = code; result.AllExited = true; return result;
            }
            if (signaled != 258) throw Error("Waiting for root process failed");
          }
          if (clock.Elapsed.TotalSeconds >= maxSeconds) { result.TimedOut = true; return result; }
          Thread.Sleep(100);
        }
      } catch (Exception ex) { result.Error = ex.Message; return result; }
      finally {
        // Never leave our newly created child suspended if job attachment failed.
        // It may run untracked in that error case, so the caller MUST preserve temp.
        if (pi.hThread != IntPtr.Zero && !resumed) {
          if (ResumeThread(pi.hThread) == 0xffffffff) result.Error = (result.Error ?? "") + "; child resume failed; suspended PID " + result.ProcessId;
        }
        if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
        if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
        if (input != Invalid) CloseHandle(input);
        if (output != Invalid) CloseHandle(output);
        if (error != Invalid) CloseHandle(error);
        if (job != IntPtr.Zero) CloseHandle(job);
      }
    }
  }
}
