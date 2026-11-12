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
        using (PayloadPackage package = OpenPayload())
        {
            foreach (ZipArchiveEntry entry in package.Archive.Entries)
            {
                string target = SafeTarget(destination, entry.FullName);
                if (entry.Name.Length == 0)
                {
                    Directory.CreateDirectory(target);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (Stream input = entry.Open())
                using (FileStream output = File.Create(target))
                    input.CopyTo(output);
            }
        }
        return destination;
    }

    public static PayloadPackage OpenPayload()
    {
        FileStream self = File.OpenRead(Application.ExecutablePath);
        try
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
            long start = self.Length - length - 8 - Magic.Length;
            SubReadStream payload = new SubReadStream(self, start, length);
            self = null;
            return new PayloadPackage(payload, new ZipArchive(payload, ZipArchiveMode.Read, true));
        }
        catch
        {
            if (self != null) self.Dispose();
            throw;
        }
    }

    public static string SafeTarget(string root, string entryName)
    {
        string relative = (entryName ?? "").Replace('/', Path.DirectorySeparatorChar);
        string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string full = Path.GetFullPath(Path.Combine(fullRoot, relative));
        if (!full.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("安装数据包含非法路径。");
        return full;
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

}

internal sealed class PayloadPackage : IDisposable
{
    public readonly ZipArchive Archive;
    private readonly Stream payload;

    public PayloadPackage(Stream payload, ZipArchive archive)
    {
        this.payload = payload;
        Archive = archive;
    }

    public void Dispose()
    {
        Archive.Dispose();
        payload.Dispose();
    }
}

internal sealed class SubReadStream : Stream
{
    private readonly Stream baseStream;
    private readonly long start;
    private readonly long length;
    private long position;

    public SubReadStream(Stream baseStream, long start, long length)
    {
        this.baseStream = baseStream;
        this.start = start;
        this.length = length;
        baseStream.Seek(start, SeekOrigin.Begin);
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return length; } }
    public override long Position
    {
        get { return position; }
        set { position = Math.Max(0, Math.Min(length, value)); baseStream.Seek(start + position, SeekOrigin.Begin); }
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        long remaining = length - position;
        if (remaining <= 0) return 0;
        int read = baseStream.Read(buffer, offset, (int)Math.Min(count, remaining));
        position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        long next = origin == SeekOrigin.Begin ? offset :
            origin == SeekOrigin.Current ? position + offset : length + offset;
        Position = next;
        return position;
    }

    public override void Flush() { }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }

    protected override void Dispose(bool disposing)
    {
        if (disposing) baseStream.Dispose();
        base.Dispose(disposing);
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
        try
        {
            SetStatus("正在读取内置安装数据…");
            string target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "gsd-pet");
            using (PayloadPackage package = Program.OpenPayload())
            {
                List<ZipArchiveEntry> entries = package.Archive.Entries
                    .Where(entry => entry.FullName.StartsWith("gsd-pet-lite/", StringComparison.OrdinalIgnoreCase))
                    .ToList();
                if (entries.Count == 0) throw new DirectoryNotFoundException("安装数据中缺少 gsd-pet-lite 目录。");

                SetStatus("正在关闭旧版进程…");
                StopOldProcesses();
                Directory.CreateDirectory(target);
                SetStatus("正在安装到 " + target + "…");
                for (int i = 0; i < entries.Count; i++)
                {
                    ZipArchiveEntry entry = entries[i];
                    string relative = entry.FullName.Substring("gsd-pet-lite/".Length);
                    if (relative.Length == 0) continue;
                    string destination = Program.SafeTarget(target, relative);
                    if (entry.Name.Length == 0)
                    {
                        Directory.CreateDirectory(destination);
                    }
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                        using (Stream input = entry.Open())
                        using (FileStream output = File.Create(destination))
                            input.CopyTo(output);
                    }
                    Progress((i + 1) * 100 / Math.Max(1, entries.Count));
                    if ((i + 1) % 40 == 0) SetStatus("正在安装文件 " + (i + 1) + " / " + entries.Count + "…");
                }
            }

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
