// Student Mail Viewer launcher (single EXE)
// Build:  csc /target:winexe /out:EmailViewer.exe tools\EmailViewerLauncher.cs
// Usage:
//   EmailViewer.exe            start server silently (if needed) and open browser
//   EmailViewer.exe silent     start server silently only (used by Windows startup)
//   EmailViewer.exe debug      start server in a visible console window (live logs)
//   EmailViewer.exe stop       stop the background server (port 3869)
//   EmailViewer.exe status     show a message box with current status
// C# 5 compatible (compiled by .NET Framework csc.exe). ASCII only.
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const int PORT = 3869;
    const string URL = "http://127.0.0.1:3869";

    [STAThread]
    static int Main(string[] args)
    {
        string mode = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "start";
        string baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        try
        {
            switch (mode)
            {
                case "silent": return RunSilent(baseDir);
                case "debug": return RunDebug(baseDir);
                case "stop": return RunStop(baseDir);
                case "status": return RunStatus(baseDir);
                case "help":
                case "/?":
                    MessageBox.Show(
                        "EmailViewer.exe [silent|debug|stop|status]\r\n\r\n" +
                        "  (no args)  start server in background and open browser\r\n" +
                        "  silent     start server in background only\r\n" +
                        "  debug      start server with a visible log window\r\n" +
                        "  stop       stop the background server\r\n" +
                        "  status     show current status",
                        "Student Mail Viewer");
                    return 0;
                default: return RunStart(baseDir);
            }
        }
        catch (Exception ex)
        {
            Log(baseDir, "ERROR " + ex.Message);
            MessageBox.Show("启动失败：" + ex.Message, "Student Mail Viewer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static int RunStart(string baseDir)
    {
        if (!EnsureDependencies(baseDir, false)) return 1;
        if (!IsRunning())
        {
            if (!StartHidden(baseDir)) return 1;
            for (int i = 0; i < 40 && !IsRunning(); i++) Thread.Sleep(500);
        }
        OpenBrowser();
        Log(baseDir, "start (browser opened)");
        return 0;
    }

    static int RunSilent(string baseDir)
    {
        if (IsRunning()) { Log(baseDir, "silent: already running"); return 0; }
        // 开机自启场景：依赖缺失时不弹窗打扰，仅记录日志
        string serverDir = Path.Combine(baseDir, "server");
        if (!Directory.Exists(Path.Combine(serverDir, "node_modules")))
        {
            Log(baseDir, "silent: dependencies missing, please run EmailViewer.exe once");
            return 1;
        }
        if (!StartHidden(baseDir)) return 1;
        Log(baseDir, "silent: started");
        return 0;
    }

    /// <summary>首次运行时安装依赖 / 构建前端（可见窗口显示进度）</summary>
    static bool EnsureDependencies(string baseDir, bool silentMode)
    {
        string serverDir = Path.Combine(baseDir, "server");
        string webDir = Path.Combine(baseDir, "web");
        string cache = Path.Combine(baseDir, ".npm-cache");
        bool needServer = !Directory.Exists(Path.Combine(serverDir, "node_modules"));
        bool needWeb = !Directory.Exists(Path.Combine(webDir, "node_modules"));
        bool needBuild = !File.Exists(Path.Combine(webDir, "dist\\index.html"));
        if (!needServer && !needWeb && !needBuild) return true;
        if (silentMode)
        {
            Log(baseDir, "silent: first run needs setup; skipping");
            return false;
        }
        if (needServer)
        {
            if (!RunVisible(baseDir, serverDir, "npm.cmd install --no-audit --no-fund --cache \"" + cache + "\"")) return false;
        }
        if (needWeb)
        {
            if (!RunVisible(baseDir, webDir, "npm.cmd install --no-audit --no-fund --ignore-scripts --cache \"" + cache + "\"")) return false;
        }
        if (needBuild)
        {
            if (!RunVisible(baseDir, webDir, "npm.cmd run build")) return false;
        }
        return true;
    }

    /// <summary>在可见控制台窗口中执行命令并等待完成（首次安装依赖时用户能看到进度）</summary>
    static bool RunVisible(string baseDir, string workDir, string command)
    {
        Log(baseDir, "setup: " + command);
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        psi.Arguments = "/c " + command;
        psi.WorkingDirectory = workDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = false;
        Process p = Process.Start(psi);
        if (p == null) return false;
        p.WaitForExit();
        if (p.ExitCode != 0)
        {
            Log(baseDir, "setup failed: " + command + " (exit " + p.ExitCode + ")");
            MessageBox.Show("首次安装依赖失败（退出码 " + p.ExitCode + "）。\r\n请确认已安装 Node.js，并检查网络后重试。\r\n详见 server\\data\\server.log 与 launcher.log。",
                "Student Mail Viewer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        return true;
    }

    static int RunDebug(string baseDir)
    {
        if (IsRunning())
        {
            MessageBox.Show("服务已在运行（" + URL + "）。如需重启，请先运行 stop。", "Student Mail Viewer");
            return 0;
        }
        if (!EnsureDependencies(baseDir, false)) return 1;
        string server = Path.Combine(baseDir, "server");
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
        psi.Arguments = "/k node src\\index.js";
        psi.WorkingDirectory = server;
        psi.UseShellExecute = true;
        Process.Start(psi);
        Log(baseDir, "debug: console started");
        return 0;
    }

    static int RunStop(string baseDir)
    {
        int killed = 0;
        string output = RunCapture("cmd.exe", "/c netstat -ano | findstr LISTENING | findstr :" + PORT);
        foreach (string raw in output.Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;
            string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 5) continue;
            int pid;
            if (!int.TryParse(parts[parts.Length - 1], out pid)) continue;
            try
            {
                ProcessStartInfo tk = new ProcessStartInfo();
                tk.FileName = "taskkill.exe";
                tk.Arguments = "/F /PID " + pid;
                tk.UseShellExecute = false;
                tk.CreateNoWindow = true;
                Process p = Process.Start(tk);
                if (p != null) { p.WaitForExit(5000); killed++; }
            }
            catch { }
        }
        Log(baseDir, "stop: killed " + killed);
        return 0;
    }

    static int RunStatus(string baseDir)
    {
        bool running = IsRunning();
        string node = FindNode();
        StringBuilder sb = new StringBuilder();
        sb.AppendLine(running ? "状态：正在运行" : "状态：未运行");
        sb.AppendLine("地址：" + URL);
        sb.AppendLine("目录：" + baseDir);
        sb.AppendLine("Node：" + (node == null ? "(未找到，请先安装 Node.js)" : node));
        MessageBox.Show(sb.ToString(), "Student Mail Viewer");
        return 0;
    }

    static bool StartHidden(string baseDir)
    {
        string node = FindNode();
        if (node == null)
        {
            MessageBox.Show(
                "未找到 Node.js。\r\n请先安装 Node.js 22 或更高版本：https://nodejs.org",
                "Student Mail Viewer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        string server = Path.Combine(baseDir, "server");
        if (!File.Exists(Path.Combine(server, "src\\index.js")))
        {
            MessageBox.Show("缺少 server\\src\\index.js，请确认解压完整。", "Student Mail Viewer");
            return false;
        }
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = "src\\index.js";
        psi.WorkingDirectory = server;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        Process.Start(psi);
        return true;
    }

    static string FindNode()
    {
        string pf = Environment.GetEnvironmentVariable("ProgramFiles");
        if (!string.IsNullOrEmpty(pf))
        {
            string p = Path.Combine(pf, "nodejs\\node.exe");
            if (File.Exists(p)) return p;
        }
        string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)");
        if (!string.IsNullOrEmpty(pf86))
        {
            string p2 = Path.Combine(pf86, "nodejs\\node.exe");
            if (File.Exists(p2)) return p2;
        }
        // fall back to PATH resolution
        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathVar))
        {
            foreach (string dir in pathVar.Split(';'))
            {
                if (dir.Trim().Length == 0) continue;
                try
                {
                    string cand = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(cand)) return cand;
                }
                catch { }
            }
        }
        return null;
    }

    static bool IsRunning()
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", PORT, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(400)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static void OpenBrowser()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = URL;
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch { }
    }

    static string RunCapture(string file, string arguments)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = file;
            psi.Arguments = arguments;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.CreateNoWindow = true;
            Process p = Process.Start(psi);
            string text = p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            return text;
        }
        catch { return ""; }
    }

    static void Log(string baseDir, string message)
    {
        try
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + "\r\n";
            File.AppendAllText(Path.Combine(baseDir, "launcher.log"), line, Encoding.UTF8);
        }
        catch { }
    }
}
