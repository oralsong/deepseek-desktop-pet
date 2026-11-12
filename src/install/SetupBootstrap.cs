using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program
{
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("GSD-PET-PAYLOAD-V1");

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length >= 2 && string.Equals(args[0], "--extract-only", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                Directory.CreateDirectory(args[1]);
                ExtractPayload(args[1]);
                Console.WriteLine("PAYLOAD_EXTRACTED " + Path.GetFullPath(args[1]));
                Environment.ExitCode = 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                Environment.ExitCode = 1;
            }
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new InstallerForm());
    }

    public static string ExtractPayload(string destination)
    {
        string zip = Path.Combine(Path.GetTempPath(), "gsd-pet-payload-" + Guid.NewGuid().ToString("N") + ".zip");
        try
        {
            using (FileStream self = File.OpenRead(Application.ExecutablePath))
            {
                if (self.Length < Magic.Length + 8) throw new InvalidDataException("安装器缺少内置数据。");
                self.Seek(-(Magic.Length + 8), SeekOrigin.End);
                byte[] trailer = new byte[8 + Magic.Length];
                ReadExactly(self, trailer);
                for (int i = 0; i < Magic.Length; i++)
                {
                    if (trailer[8 + i] != Magic[i]) throw new InvalidDataException("安装器数据标记无效。");
                }
                long length = BitConverter.ToInt64(trailer, 0);
                if (length <= 0 || length > self.Length - 8 - Magic.Length) throw new InvalidDataException("安装器数据长度无效。");
                self.Seek(-(length + 8 + Magic.Length), SeekOrigin.End);
                using (FileStream output = File.Create(zip))
                {
                    CopyExactly(self, output, length);
                }
            }
            ZipFile.ExtractToDirectory(zip, destination);
            return destination;
        }
        finally
        {
            try { if (File.Exists(zip)) File.Delete(zip); } catch { }
        }
    }

    private static void ReadExactly(Stream stream, byte[] buffer)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = stream.Read(buffer, offset, buffer.Length - offset);
            if (read <= 0) throw new EndOfStreamException();
            offset += read;
        }
    }

    private static void CopyExactly(Stream input, Stream output, long length)
    {
        byte[] buffer = new byte[1024 * 1024];
        long remaining = length;
        while (remaining > 0)
        {
            int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
            if (read <= 0) throw new EndOfStreamException();
            output.Write(buffer, 0, read);
            remaining -= read;
        }
    }
}

internal sealed class InstallerForm : Form
{
    private readonly Label title;
    private readonly Label status;
    private readonly ProgressBar progress;
    private readonly TextBox details;

    public InstallerForm()
    {
        Text = "gsd特制大肥鱼桌宠 安装程序";
        ClientSize = new Size(620, 330);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(18, 22, 31);
        ForeColor = Color.FromArgb(230, 238, 252);
        Font = new Font("Microsoft YaHei UI", 9F);

        title = new Label
        {
            Text = "gsd特制大肥鱼桌宠 v1.1",
            ForeColor = Color.FromArgb(78, 163, 255),
            Font = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(28, 24)
        };
        Controls.Add(title);

        status = new Label
        {
            Text = "准备安装…",
            ForeColor = Color.FromArgb(201, 214, 232),
            AutoSize = true,
            Location = new Point(30, 78)
        };
        Controls.Add(status);

        progress = new ProgressBar
        {
            Location = new Point(30, 108),
            Size = new Size(560, 20),
            Style = ProgressBarStyle.Marquee,
            MarqueeAnimationSpeed = 28
        };
        Controls.Add(progress);

        details = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = Color.FromArgb(27, 33, 48),
            ForeColor = Color.FromArgb(183, 199, 221),
            BorderStyle = BorderStyle.FixedSingle,
            Location = new Point(30, 146),
            Size = new Size(560, 150),
            Font = new Font("Consolas", 9F)
        };
        Controls.Add(details);

        Shown += delegate { Task.Run(new Action(Install)); };
    }

    private void Install()
    {
        string temp = Path.Combine(Path.GetTempPath(), "gsd-pet-install-" + Guid.NewGuid().ToString("N"));
        try
        {
            SetStatus("正在读取内置安装数据…");
            Directory.CreateDirectory(temp);
            Program.ExtractPayload(temp);
            string source = Directory.GetDirectories(temp, "gsd-pet-lite", SearchOption.TopDirectoryOnly).FirstOrDefault();
            if (source == null) throw new DirectoryNotFoundException("安装数据中缺少 gsd-pet-lite 目录。");

            SetStatus("正在关闭旧版进程…");
            StopOldProcesses();

            string target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "gsd-pet");
            SetStatus("正在安装到 " + target + "…");
            CopyDirectory(source, target, temp);

            SetStatus("正在创建快捷方式…");
            string exe = Path.Combine(target, "gsd大肥鱼桌宠.exe");
            CreateShortcut(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "gsd特制大肥鱼桌宠.lnk"),
                exe, target, Path.Combine(target, "pet.ico"));
            WriteUninstallEntry(target);

            SetStatus("安装完成，正在启动…");
            Progress(100);
            Process.Start(new ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = target,
                UseShellExecute = true
            });
            BeginInvoke(new Action(Close));
        }
        catch (Exception error)
        {
            SetStatus("安装失败");
            Append(error.ToString());
            BeginInvoke(new Action(delegate
            {
                progress.Style = ProgressBarStyle.Continuous;
                progress.Value = 0;
                MessageBox.Show(this,
                    "安装失败：\n" + error.Message + "\n\n详细信息已显示在窗口中。",
                    "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }));
        }
        finally
        {
            try { Directory.Delete(temp, true); } catch { }
        }
    }

    private void CopyDirectory(string source, string target, string tempRoot)
    {
        string[] files = Directory.GetFiles(source, "*", SearchOption.AllDirectories);
        for (int i = 0; i < files.Length; i++)
        {
            string relative = files[i].Substring(source.Length).TrimStart('\\', '/');
            string destination = Path.Combine(target, relative);
            string directory = Path.GetDirectoryName(destination);
            if (!Directory.Exists(directory)) Directory.CreateDirectory(directory);
            File.Copy(files[i], destination, true);
            Progress((i + 1) * 100 / Math.Max(1, files.Length));
            if ((i + 1) % 40 == 0) SetStatus("正在复制文件 " + (i + 1) + " / " + files.Length + "…");
        }
    }

    private static void StopOldProcesses()
    {
        try
        {
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe' OR Name='gsd大肥鱼桌宠.exe'"))
            using (ManagementObjectCollection rows = searcher.Get())
            {
                foreach (ManagementBaseObject row in rows)
                {
                    try
                    {
                        string command = Convert.ToString(row["CommandLine"]) ?? "";
                        if (command.IndexOf("gsd-pet", StringComparison.OrdinalIgnoreCase) < 0 &&
                            command.IndexOf("standalone.js", StringComparison.OrdinalIgnoreCase) < 0 &&
                            command.IndexOf("pet-voice", StringComparison.OrdinalIgnoreCase) < 0 &&
                            command.IndexOf("gsd大肥鱼桌宠", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        Process.GetProcessById(Convert.ToInt32(row["ProcessId"])).Kill();
                    }
                    catch { }
                }
            }
        }
        catch { }
    }

    private static void CreateShortcut(string path, string target, string workdir, string icon)
    {
        object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        object shortcut = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type type = shortcut.GetType();
        type.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { target });
        type.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { workdir });
        type.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { icon + ",0" });
        type.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
    }

    private static void WriteUninstallEntry(string target)
    {
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\gsd-pet"))
        {
            if (key == null) return;
            key.SetValue("DisplayName", "gsd特制大肥鱼桌宠");
            key.SetValue("DisplayIcon", Path.Combine(target, "pet.ico") + ",0");
            key.SetValue("InstallLocation", target);
            key.SetValue("DisplayVersion", "1.1");
            key.SetValue("Publisher", "gsd");
            key.SetValue("UninstallString", "\"cmd.exe\" /c \"\"" + Path.Combine(target, "uninstall.cmd") + "\"\"");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    private void SetStatus(string text)
    {
        if (IsDisposed) return;
        BeginInvoke(new Action(delegate
        {
            status.Text = text;
            Append(text);
        }));
    }

    private void Append(string text)
    {
        if (IsDisposed) return;
        BeginInvoke(new Action(delegate
        {
            details.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + text.Replace("\r\n", " | ").Replace("\n", " | ") + Environment.NewLine);
        }));
    }

    private void Progress(int value)
    {
        if (IsDisposed) return;
        BeginInvoke(new Action(delegate
        {
            progress.Style = ProgressBarStyle.Continuous;
            progress.Value = Math.Max(0, Math.Min(100, value));
        }));
    }
}
