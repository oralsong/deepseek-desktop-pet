using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Management;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class DesktopPetLauncher
{
    private const string Title = "gsd特制大肥鱼桌宠";
    private const string Sub = "会看屏幕陪你玩、会用自己的声音说话、还听得见你说话";
    private const int VoicePort = 8848;
    private static readonly Color Bg = Color.FromArgb(18, 22, 31);
    private static readonly Color PanelBg = Color.FromArgb(27, 33, 48);
    private static readonly Color InputBg = Color.FromArgb(15, 20, 32);
    private static readonly Color Accent = Color.FromArgb(78, 163, 255);
    private static readonly Color Muted = Color.FromArgb(143, 163, 191);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm(args));
        }
        catch (Exception error)
        {
            try
            {
                File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.log"),
                    "[FATAL] " + error + Environment.NewLine, Encoding.UTF8);
                Console.Error.WriteLine(error);
            }
            catch { }
            throw;
        }
    }
}

internal sealed class LauncherForm : Form
{
    private readonly string[] args;
    private readonly string baseDir;
    private readonly string petPkg;
    private readonly string nodeExe;
    private readonly string electronExe;
    private readonly string pythonExe;
    private readonly string voiceScript;
    private readonly string dataDir;
    private readonly string petConfigDir;
    private readonly string aiFile;
    private readonly string peekFile;
    private readonly string runtimeFile;
    private readonly string configFile;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly object logLock = new object();
    private readonly List<string> logs = new List<string>();
    private readonly Timer statusTimer = new Timer();

    private TextBox nameBox;
    private TextBox personaBox;
    private TextBox speechBox;
    private TextBox voiceRefBox;
    private TextBox keyBox;
    private TextBox modelBox;
    private TextBox baseUrlBox;
    private TextBox statusBox;
    private Button runButton;
    private CheckBox autostartBox;
    private bool statusBusy;
    private bool runBusy;
    private List<string> statusLines = new List<string>();

    public LauncherForm(string[] arguments)
    {
        args = arguments ?? new string[0];
        baseDir = Path.GetDirectoryName(typeof(LauncherForm).Assembly.Location);
        petPkg = Path.Combine(baseDir, "app", "dsh-pet");
        nodeExe = Path.Combine(baseDir, "runtime", "node.exe");
        electronExe = Path.Combine(baseDir, "runtime", "electron", "electron.exe");
        pythonExe = Path.Combine(baseDir, "runtime", "python", "pythonw.exe");
        if (!File.Exists(pythonExe)) pythonExe = Path.Combine(baseDir, "runtime", "python", "python.exe");
        voiceScript = Path.Combine(baseDir, "app", "pet-voice", "server.py");
        dataDir = Path.Combine(baseDir, "data");
        petConfigDir = Path.Combine(dataDir, "dsh-pet");
        aiFile = Path.Combine(petConfigDir, "standalone-ai.json");
        peekFile = Path.Combine(petConfigDir, "peek.json");
        runtimeFile = Path.Combine(petConfigDir, "standalone-runtime.json");
        configFile = Path.Combine(dataDir, "config.json");

        BuildUi();
        LoadSettings();
        statusTimer.Interval = 3000;
        statusTimer.Tick += delegate { RefreshStatus(); };
        statusTimer.Start();
        Shown += delegate
        {
            RefreshStatus();
            if (HasArg("--autostart")) BeginInvoke(new Action(RunPet));
        };
    }

    private void BuildUi()
    {
        Text = DesktopPetLauncher2.Title;
        BackColor = DesktopPetLauncher2.Bg;
        ForeColor = Color.FromArgb(201, 214, 232);
        Font = new Font("Microsoft YaHei UI", 9F);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(780, 900);
        MinimumSize = new Size(720, 760);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var header = new Label
        {
            Text = DesktopPetLauncher2.Title,
            Font = new Font("Microsoft YaHei UI", 20F, FontStyle.Bold),
            ForeColor = DesktopPetLauncher2.Accent,
            AutoSize = true,
            Location = new Point(24, 16)
        };
        Controls.Add(header);
        Controls.Add(new Label
        {
            Text = DesktopPetLauncher2.Sub,
            ForeColor = Color.FromArgb(136, 153, 176),
            AutoSize = true,
            Location = new Point(26, 58)
        });

        var tabs = new TabControl
        {
            Location = new Point(24, 86),
            Size = new Size(732, 620),
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
        };
        tabs.TabPages.Add(BuildIdentityTab());
        tabs.TabPages.Add(BuildModelTab());
        tabs.TabPages.Add(BuildStatusTab());
        Controls.Add(tabs);

        runButton = new Button
        {
            Text = "保存并运行",
            BackColor = Color.FromArgb(47, 109, 246),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold),
            Location = new Point(24, 718),
            Size = new Size(732, 48),
            Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top
        };
        runButton.FlatAppearance.BorderSize = 0;
        runButton.Click += delegate { RunPet(); };
        Controls.Add(runButton);

        autostartBox = new CheckBox
        {
            Text = "开机自启动（登录后自动把桌宠拉起来）",
            ForeColor = Color.FromArgb(169, 184, 206),
            AutoSize = true,
            Location = new Point(26, 776)
        };
        autostartBox.CheckedChanged += delegate { SaveSettings(); SetAutostart(autostartBox.Checked); };
        Controls.Add(autostartBox);

        var bar = new Panel { Location = new Point(24, 812), Size = new Size(732, 42), Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom };
        Controls.Add(bar);
        AddFlatButton(bar, "创建桌面快捷方式", 0, delegate { CreateDesktopShortcut(); });
        AddFlatButton(bar, "停止桌宠", 150, delegate { StopPetProcesses(); });
        var refresh = AddFlatButton(bar, "刷新状态", 280, delegate { RefreshStatus(); });
        refresh.Anchor = AnchorStyles.Right;
        refresh.Left = bar.Width - refresh.Width;
    }

    private TabPage BuildIdentityTab()
    {
        var page = NewPage("人设与声音");
        var table = NewTable();
        AddLabel(table, "名字", 0);
        nameBox = NewInput(false);
        table.Controls.Add(nameBox, 1, 0);

        AddLabel(table, "人设 / 关系", 1);
        personaBox = NewInput(true);
        personaBox.Height = 150;
        table.Controls.Add(personaBox, 1, 1);

        AddLabel(table, "说话参考", 2);
        speechBox = NewInput(true);
        speechBox.Height = 120;
        table.Controls.Add(speechBox, 1, 2);

        AddLabel(table, "音色参考", 3);
        var voicePanel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        voicePanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        voicePanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 106F));
        voiceRefBox = NewInput(false);
        voicePanel.Controls.Add(voiceRefBox, 0, 0);
        var browse = NewSmallButton("选择 WAV");
        browse.Click += delegate
        {
            using (var dialog = new OpenFileDialog())
            {
                dialog.Title = "选择克隆音色参考音频";
                dialog.Filter = "WAV 音频|*.wav|所有文件|*.*";
                if (dialog.ShowDialog(this) == DialogResult.OK) voiceRefBox.Text = dialog.FileName;
            }
        };
        voicePanel.Controls.Add(browse, 1, 0);
        table.Controls.Add(voicePanel, 1, 3);

        table.Controls.Add(new Label
        {
            Text = "人设决定它怎么看你；说话参考决定语气、长度、称呼和禁忌。\n没有安装语音包时会自动使用 Windows 系统语音。",
            ForeColor = DesktopPetLauncher2.Muted,
            AutoSize = true,
            MaximumSize = new Size(500, 0)
        }, 1, 4);
        page.Controls.Add(table);
        return page;
    }

    private TabPage BuildModelTab()
    {
        var page = NewPage("模型连接");
        var table = NewTable();
        AddLabel(table, "API Key", 0);
        keyBox = NewInput(false);
        keyBox.UseSystemPasswordChar = true;
        table.Controls.Add(keyBox, 1, 0);

        AddLabel(table, "模型", 1);
        modelBox = NewInput(false);
        table.Controls.Add(modelBox, 1, 1);

        AddLabel(table, "API 地址", 2);
        baseUrlBox = NewInput(false);
        table.Controls.Add(baseUrlBox, 1, 2);

        var show = new CheckBox { Text = "显示 API Key", ForeColor = DesktopPetLauncher2.Muted, AutoSize = true };
        show.CheckedChanged += delegate { keyBox.UseSystemPasswordChar = !show.Checked; };
        table.Controls.Add(show, 1, 3);
        table.Controls.Add(new Label
        {
            Text = "DeepSeek 常用配置：模型 deepseek-flash，地址 https://api.deepseek.com\n密钥只保存在本机 data 目录。",
            ForeColor = DesktopPetLauncher2.Muted,
            AutoSize = true,
            MaximumSize = new Size(500, 0)
        }, 1, 4);
        page.Controls.Add(table);
        return page;
    }

    private TabPage BuildStatusTab()
    {
        var page = NewPage("运行状态");
        statusBox = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            Dock = DockStyle.Fill,
            BackColor = DesktopPetLauncher2.PanelBg,
            ForeColor = Color.FromArgb(183, 199, 221),
            BorderStyle = BorderStyle.None,
            Font = new Font("Consolas", 10F)
        };
        page.Controls.Add(statusBox);
        return page;
    }

    private TabPage NewPage(string text)
    {
        var page = new TabPage(text) { BackColor = DesktopPetLauncher2.PanelBg, Padding = new Padding(14) };
        return page;
    }

    private static TableLayoutPanel NewTable()
    {
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 6,
            Padding = new Padding(6)
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120F));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        for (int i = 0; i < 4; i++) table.RowStyles.Add(new RowStyle(SizeType.Absolute, i == 0 || i == 3 ? 52F : 128F));
        table.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        table.RowStyles.Add(new RowStyle(SizeType.Absolute, 0F));
        return table;
    }

    private static void AddLabel(TableLayoutPanel table, string text, int row)
    {
        table.Controls.Add(new Label
        {
            Text = text,
            ForeColor = Color.FromArgb(201, 214, 232),
            AutoSize = true,
            Anchor = AnchorStyles.Left | AnchorStyles.Top,
            Margin = new Padding(3, 12, 10, 3)
        }, 0, row);
    }

    private static TextBox NewInput(bool multiline)
    {
        return new TextBox
        {
            Multiline = multiline,
            Dock = DockStyle.Fill,
            BackColor = DesktopPetLauncher2.InputBg,
            ForeColor = Color.FromArgb(230, 238, 252),
            BorderStyle = BorderStyle.FixedSingle,
            ScrollBars = multiline ? ScrollBars.Vertical : ScrollBars.None,
            AcceptsReturn = multiline,
            Font = new Font("Microsoft YaHei UI", 9F)
        };
    }

    private static Button AddFlatButton(Control parent, string text, int left, EventHandler click)
    {
        var button = NewSmallButton(text);
        button.Left = left;
        button.Top = 0;
        button.Click += click;
        parent.Controls.Add(button);
        return button;
    }

    private static Button NewSmallButton(string text)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = true,
            Height = 34,
            BackColor = Color.FromArgb(44, 53, 71),
            ForeColor = Color.FromArgb(220, 232, 247),
            FlatStyle = FlatStyle.Flat,
            Padding = new Padding(8, 0, 8, 0)
        };
        button.FlatAppearance.BorderSize = 0;
        return button;
    }

    private void LoadSettings()
    {
        var cfg = ReadJson(configFile);
        string identityName;
        string identityPrompt;
        ReadIdentity(out identityName, out identityPrompt);
        nameBox.Text = TextValue(cfg, "petName", string.IsNullOrWhiteSpace(identityName) ? "哦鲸鲸" : identityName);
        personaBox.Text = TextValue(cfg, "persona", identityPrompt);
        speechBox.Text = TextValue(cfg, "speechReference", "");
        voiceRefBox.Text = TextValue(cfg, "voiceRef", "");
        keyBox.Text = TextValue(cfg, "apiKey", "");
        modelBox.Text = TextValue(cfg, "model", "deepseek-flash");
        baseUrlBox.Text = TextValue(cfg, "baseUrl", "https://api.deepseek.com");
        autostartBox.Checked = BoolValue(cfg, "autostart", false);
    }

    private Dictionary<string, object> CollectSettings()
    {
        var cfg = ReadJson(configFile);
        cfg["petName"] = nameBox.Text.Trim();
        if (string.IsNullOrEmpty(TextValue(cfg, "petName", ""))) cfg["petName"] = "哦鲸鲸";
        cfg["persona"] = personaBox.Text.Trim();
        cfg["speechReference"] = speechBox.Text.Trim();
        cfg["voiceRef"] = voiceRefBox.Text.Trim();
        cfg["apiKey"] = keyBox.Text.Trim();
        cfg["model"] = string.IsNullOrWhiteSpace(modelBox.Text) ? "deepseek-flash" : modelBox.Text.Trim();
        cfg["baseUrl"] = string.IsNullOrWhiteSpace(baseUrlBox.Text) ? "https://api.deepseek.com" : baseUrlBox.Text.Trim();
        cfg["autostart"] = autostartBox.Checked;
        return cfg;
    }

    private void SaveSettings()
    {
        if (nameBox == null) return;
        WriteJson(configFile, CollectSettings());
    }

    private void RunPet()
    {
        if (runBusy) return;
        var cfg = CollectSettings();
        WriteJson(configFile, cfg);
        if (string.IsNullOrEmpty(TextValue(cfg, "apiKey", "")) && !HasArg("--autostart"))
        {
            var answer = MessageBox.Show(this,
                "没填 API Key 也能把桌宠拉起来，但它看不见画面、也不会说话。\n要它陪玩，请填一个能看图的 API。\n\n现在先不填，直接运行吗？",
                "还没填 API Key", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (answer != DialogResult.OK) return;
        }
        runBusy = true;
        runButton.Enabled = false;
        runButton.Text = "启动中…";
        Log("开始启动（桌宠和语音并行加载）…");
        Task.Run(delegate
        {
            try
            {
                PrepareRuntime(cfg);
                Task voice = Task.Run(delegate { StartVoice(cfg); });
                StartPet(cfg);
                try { voice.Wait(15000); } catch { }
            }
            catch (Exception error)
            {
                Log("运行出错：" + error.Message);
            }
            BeginInvoke(new Action(delegate
            {
                runBusy = false;
                runButton.Enabled = true;
                runButton.Text = "保存并运行";
                RefreshStatus();
            }));
        });
    }

    private void PrepareRuntime(Dictionary<string, object> cfg)
    {
        Directory.CreateDirectory(petConfigDir);
        EnsureMainConfig();
        EnsurePeekConfig(TextValue(cfg, "speechReference", ""));
        WritePetConfig(TextValue(cfg, "petName", "哦鲸鲸"), ComposePersona(TextValue(cfg, "persona", ""), TextValue(cfg, "speechReference", "")));
        WriteAiConfig(cfg);
    }

    private void StartPet(Dictionary<string, object> cfg)
    {
        if (!File.Exists(nodeExe) || !File.Exists(Path.Combine(petPkg, "lib", "standalone.js")))
        {
            Log("安装包不完整：找不到 node 或 standalone.js");
            return;
        }
        if (PetPort() > 0)
        {
            Log("桌宠已经在跑了");
            return;
        }
        var info = new ProcessStartInfo
        {
            FileName = nodeExe,
            Arguments = "\"" + Path.Combine(petPkg, "lib", "standalone.js") + "\" --port 3080",
            WorkingDirectory = petPkg,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        info.EnvironmentVariables["DSH_HOME"] = dataDir;
        info.EnvironmentVariables["DSH_PET_ELECTRON_PATH"] = electronExe;
        info.EnvironmentVariables["DSH_PET_CONFIG"] = peekFile;
        try
        {
            Process child = Process.Start(info);
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data)) Log("[node] " + e.Data);
            };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data)) Log("[node:error] " + e.Data);
            };
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            Log("桌宠进程已启动（pid " + child.Id + "）");
            for (int i = 0; i < 60; i++)
            {
                System.Threading.Thread.Sleep(250);
                if (child.HasExited)
                {
                    Log("桌宠进程提前退出，退出码 " + child.ExitCode);
                    return;
                }
                if (IsPortOpen(3080))
                {
                    int port = PetPort();
                    Log("桌宠起来了（127.0.0.1:" + (port > 0 ? port : 3080) + "）");
                    return;
                }
            }
        }
        catch (Exception error)
        {
            Log("启动桌宠失败：" + error.Message);
            return;
        }
        Log("桌宠启动超时（15 秒），详细错误见上方 node 日志");
    }

    private static bool IsPortOpen(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(120)) return false;
                client.EndConnect(result);
                return true;
            }
        }
        catch { return false; }
    }

    private void StartVoice(Dictionary<string, object> cfg)
    {
        if (!File.Exists(pythonExe) || !File.Exists(voiceScript))
        {
            Log("没有安装语音包：先用系统语音，克隆音色随后安装语音包即可");
            return;
        }
        var health = VoiceHealth();
        string refPath = TextValue(cfg, "voiceRef", "");
        if (health.ContainsKey("ready") && IsTrue(health["ready"]) || health.ContainsKey("loading") && IsTrue(health["loading"]))
        {
            string current = TextValue(health, "ref", "");
            if (!string.IsNullOrEmpty(refPath) && !string.IsNullOrEmpty(current) && !string.Equals(Path.GetFullPath(refPath), Path.GetFullPath(current), StringComparison.OrdinalIgnoreCase))
            {
                StopProcessesByCommand("pet-voice", "server.py");
                System.Threading.Thread.Sleep(400);
            }
            else
            {
                Log(IsTrue(health.ContainsKey("ready") ? health["ready"] : null) ? "语音服务已在运行" : "语音服务正在加载模型，桌宠无需等待");
                return;
            }
        }
        var info = new ProcessStartInfo
        {
            FileName = pythonExe,
            WorkingDirectory = Path.GetDirectoryName(voiceScript),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            Arguments = "\"" + voiceScript + "\" --port " + DesktopPetLauncher2.VoicePort +
                (string.IsNullOrEmpty(refPath) || !File.Exists(refPath) ? "" : " --ref \"" + refPath + "\"")
        };
        try
        {
            Process.Start(info);
            Log("语音服务开始后台加载模型");
        }
        catch (Exception error)
        {
            Log("启动语音服务失败：" + error.Message);
        }
    }

    private void RefreshStatus()
    {
        if (statusBusy || statusBox == null) return;
        statusBusy = true;
        var cfg = CollectSettings();
        Task.Run(delegate
        {
            try
            {
                int port = PetPort();
                object pid = port > 0 ? (object)("port:" + port) : FindPetPid();
                var voice = VoiceHealth();
                string voiceText;
                if (IsTrue(voice.ContainsKey("ready") ? voice["ready"] : null)) voiceText = "就绪  :" + DesktopPetLauncher2.VoicePort;
                else if (IsTrue(voice.ContainsKey("loading") ? voice["loading"] : null)) voiceText = "模型加载中（桌宠可先用）";
                else if (voice.ContainsKey("error") && !string.IsNullOrEmpty(TextValue(voice, "error", ""))) voiceText = "加载失败：" + Short(TextValue(voice, "error", ""), 34);
                else voiceText = "未运行（会用系统语音）";
                var lines = new List<string>
                {
                    Pad("桌宠", 10) + (pid == null ? "未运行" : "运行中  pid " + pid),
                    Pad("桌宠接口", 10) + (port > 0 ? "127.0.0.1:" + port + "/dsh-pet-7340" : "还没起来"),
                    Pad("语音服务", 10) + voiceText,
                    Pad("AI", 10) + (!string.IsNullOrEmpty(TextValue(cfg, "apiKey", "")) ? "已配置  " + TextValue(cfg, "model", "deepseek-flash") : "未填 API Key"),
                    Pad("陪玩模式", 10) + (IsTrue(ReadJson(peekFile).ContainsKey("enabled") ? ReadJson(peekFile)["enabled"] : null) ? "开（右键桌宠可关）" : "关")
                };
                BeginInvoke(new Action(delegate
                {
                    statusLines = lines;
                    RenderStatus();
                    statusBusy = false;
                }));
            }
            catch
            {
                BeginInvoke(new Action(delegate { statusBusy = false; }));
            }
        });
    }

    private void RenderStatus()
    {
        if (statusBox == null) return;
        var text = new StringBuilder();
        foreach (var line in statusLines) text.AppendLine(line);
        text.AppendLine();
        lock (logLock)
        {
            foreach (var line in logs.Skip(Math.Max(0, logs.Count - 12))) text.AppendLine(line);
        }
        statusBox.Text = text.ToString();
    }

    private void Log(string message)
    {
        string line = DateTime.Now.ToString("HH:mm:ss ") + message;
        lock (logLock)
        {
            logs.Add(line);
            if (logs.Count > 80) logs.RemoveRange(0, logs.Count - 80);
        }
        try
        {
            Directory.CreateDirectory(baseDir);
            File.AppendAllText(Path.Combine(baseDir, "launcher.log"), "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
        if (IsHandleCreated) BeginInvoke(new Action(RenderStatus));
    }

    private int PetPort()
    {
        if (HttpJson("http://127.0.0.1:3080/dsh-pet-7340/config", 900) != null) return 3080;
        try
        {
            var runtime = ReadJson(runtimeFile);
            int port;
            if (int.TryParse(TextValue(runtime, "port", "0"), out port) && port > 0 && port != 3080 &&
                HttpJson("http://127.0.0.1:" + port + "/dsh-pet-7340/config", 700) != null) return port;
        }
        catch { }
        return 0;
    }

    private object FindPetPid()
    {
        string target = Path.Combine(petPkg, "lib", "standalone.js").ToLowerInvariant();
        foreach (var item in WmiProcesses())
        {
            if (item.ContainsKey("CommandLine") && TextValue(item, "CommandLine", "").ToLowerInvariant().Contains(target))
                return item["ProcessId"];
        }
        return null;
    }

    private Dictionary<string, object> VoiceHealth()
    {
        try
        {
            var result = HttpJson("http://127.0.0.1:" + DesktopPetLauncher2.VoicePort + "/health", 700);
            return result ?? new Dictionary<string, object>();
        }
        catch { return new Dictionary<string, object>(); }
    }

    private static Dictionary<string, object> HttpJson(string url, int timeoutMs)
    {
        try
        {
            using (var client = new HttpClient())
            {
                client.Timeout = TimeSpan.FromMilliseconds(timeoutMs);
                string body = client.GetStringAsync(url).GetAwaiter().GetResult();
                object parsed = new JavaScriptSerializer().DeserializeObject(body);
                var dict = parsed as Dictionary<string, object>;
                return dict ?? new Dictionary<string, object>();
            }
        }
        catch { return null; }
    }

    private Dictionary<string, object> ReadJson(string path)
    {
        try
        {
            if (!File.Exists(path)) return new Dictionary<string, object>();
            object value = json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
        catch { return new Dictionary<string, object>(); }
    }

    private void WriteJson(string path, Dictionary<string, object> value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temp = path + ".tmp";
        File.WriteAllText(temp, json.Serialize(value), new UTF8Encoding(false));
        if (File.Exists(path)) File.Delete(path);
        File.Move(temp, path);
    }

    private static string TextValue(Dictionary<string, object> dict, string key, string fallback)
    {
        if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return fallback;
        string text = Convert.ToString(dict[key]);
        return text ?? fallback;
    }

    private static bool BoolValue(Dictionary<string, object> dict, string key, bool fallback)
    {
        if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return fallback;
        try { return Convert.ToBoolean(dict[key]); } catch { return fallback; }
    }

    private static bool IsTrue(object value)
    {
        if (value == null) return false;
        try { return Convert.ToBoolean(value); } catch { return false; }
    }

    private void EnsureMainConfig()
    {
        string path = Path.Combine(petConfigDir, "main-config.jsonc");
        if (File.Exists(path)) return;
        Directory.CreateDirectory(petConfigDir);
        File.WriteAllText(path,
            "// 桌宠名字、人设与说话方式由启动器保存\r\n" +
            "{\r\n  \"pets\": [\r\n    {\r\n      \"id\": \"main\",\r\n      \"name\": \"哦鲸鲸\",\r\n" +
            "      \"size\": 462,\r\n      \"display\": \"desktop\",\r\n      \"fixedEnabled\": false,\r\n" +
            "      \"position\": { \"anchor\": \"corner\", \"corner\": \"bottom-right\" },\r\n" +
            "      \"whisperPrompt\": \"你是一只蓝鲸，我喊你蓝色大肥鱼，你喊我老大。说话像坐在旁边陪我玩游戏的朋友：短、自然、有点情绪。\"\r\n" +
            "    }\r\n  ]\r\n}\r\n", new UTF8Encoding(false));
    }

    private void ReadIdentity(out string name, out string persona)
    {
        name = "";
        persona = "";
        string path = Path.Combine(petConfigDir, "main-config.jsonc");
        if (!File.Exists(path)) return;
        string text = File.ReadAllText(path, Encoding.UTF8);
        var nameMatch = Regex.Match(text, "\"name\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        var promptMatch = Regex.Match(text, "\"whisperPrompt\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
        if (nameMatch.Success) name = UnescapeJsonString(nameMatch.Groups[1].Value);
        if (promptMatch.Success) persona = UnescapeJsonString(promptMatch.Groups[1].Value);
    }

    private void WritePetConfig(string name, string persona)
    {
        string path = Path.Combine(petConfigDir, "main-config.jsonc");
        string text = File.ReadAllText(path, Encoding.UTF8);
        string escapedName = EscapeJsonString(string.IsNullOrEmpty(name) ? "哦鲸鲸" : name);
        string escapedPersona = EscapeJsonString(persona ?? "");
        if (Regex.IsMatch(text, "\"name\"\\s*:"))
            text = new Regex("(\"name\"\\s*:\\s*\")(?:\\\\.|[^\"\\\\])*(\")").Replace(text, m => m.Groups[1].Value + escapedName + m.Groups[2].Value, 1);
        else
            text = text.Replace("\"id\": \"main\",", "\"id\": \"main\",\r\n      \"name\": \"" + escapedName + "\",");
        if (Regex.IsMatch(text, "\"whisperPrompt\"\\s*:"))
            text = new Regex("(\"whisperPrompt\"\\s*:\\s*\")(?:\\\\.|[^\"\\\\])*(\")").Replace(text, m => m.Groups[1].Value + escapedPersona + m.Groups[2].Value, 1);
        else if (!string.IsNullOrEmpty(escapedPersona))
            text = new Regex("(\"name\"\\s*:\\s*\"(?:\\\\.|[^\"\\\\])*\"\\s*,)").Replace(text, m => m.Groups[1].Value + "\r\n      \"whisperPrompt\": \"" + escapedPersona + "\",", 1);
        File.WriteAllText(path, text, new UTF8Encoding(false));
    }

    private void EnsurePeekConfig(string speechReference)
    {
        var cfg = ReadJson(peekFile);
        cfg["enabled"] = cfg.ContainsKey("enabled") ? cfg["enabled"] : true;
        cfg["petId"] = cfg.ContainsKey("petId") ? cfg["petId"] : "main";
        cfg["speak"] = cfg.ContainsKey("speak") ? cfg["speak"] : true;
        cfg["voiceService"] = "http://127.0.0.1:" + DesktopPetLauncher2.VoicePort;
        cfg["voiceServerScript"] = voiceScript;
        cfg["voicePython"] = pythonExe;
        cfg["prompt"] = ComposePeekPrompt(speechReference);
        WriteJson(peekFile, cfg);
    }

    private void WriteAiConfig(Dictionary<string, object> cfg)
    {
        var ai = new Dictionary<string, object>
        {
            {"protocol", "openai-compatible"},
            {"baseUrl", TextValue(cfg, "baseUrl", "https://api.deepseek.com")},
            {"model", TextValue(cfg, "model", "deepseek-flash")},
            {"apiKey", TextValue(cfg, "apiKey", "")},
            {"enabled", !string.IsNullOrEmpty(TextValue(cfg, "apiKey", ""))},
            {"automaticWhispers", false},
            {"whisperIntervalSec", 300},
            {"maxTokens", 512},
            {"timeoutMs", 45000}
        };
        WriteJson(aiFile, ai);
    }

    private static string ComposePersona(string persona, string speech)
    {
        persona = (persona ?? "").Trim();
        speech = (speech ?? "").Trim();
        if (persona.Length > 0 && speech.Length > 0) return persona + "\r\n\r\n说话方式参考：\r\n" + speech;
        return persona.Length > 0 ? persona : speech;
    }

    private static string ComposePeekPrompt(string speech)
    {
        string baseline = "你是陪玩模式：用户正在电脑前操作，你坐在旁边看屏幕。只说画面里正在发生的一件具体事，15~30字，像朋友随口点评。不要念菜单和按钮，不要提截图、分辨率或桌面图标；没有值得说的变化就只回复 SKIP。";
        speech = (speech ?? "").Trim();
        return speech.Length == 0 ? baseline : baseline + "\r\n说话方式参考：" + speech;
    }

    private static string EscapeJsonString(string value)
    {
        var serializer = new JavaScriptSerializer();
        string encoded = serializer.Serialize(value ?? "");
        return encoded.Substring(1, encoded.Length - 2);
    }

    private static string UnescapeJsonString(string value)
    {
        try { return new JavaScriptSerializer().Deserialize<string>("\"" + value + "\""); }
        catch { return value; }
    }

    private IEnumerable<Dictionary<string, object>> WmiProcesses()
    {
        using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe'"))
        using (var results = searcher.Get())
        {
            foreach (ManagementObject item in results)
            {
                var row = new Dictionary<string, object>();
                try { row["ProcessId"] = item["ProcessId"]; } catch { }
                try { row["CommandLine"] = item["CommandLine"]; } catch { }
                yield return row;
            }
        }
    }

    private void StopPetProcesses()
    {
        int count = StopProcessesByCommand("standalone.js") + StopProcessesByCommand("pet-voice", "server.py");
        Log("已停掉 " + count + " 个进程");
        RefreshStatus();
    }

    private int StopProcessesByCommand(params string[] parts)
    {
        int count = 0;
        foreach (var row in WmiProcesses().ToList())
        {
            string command = TextValue(row, "CommandLine", "");
            if (!parts.All(p => command.IndexOf(p, StringComparison.OrdinalIgnoreCase) >= 0)) continue;
            try
            {
                Process.GetProcessById(Convert.ToInt32(row["ProcessId"])).Kill();
                count++;
            }
            catch { }
        }
        return count;
    }

    private void SetAutostart(bool enabled)
    {
        try
        {
            string link = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), DesktopPetLauncher2.Title + ".lnk");
            if (!enabled)
            {
                if (File.Exists(link)) File.Delete(link);
                return;
            }
            CreateShortcut(link, Application.ExecutablePath, "--autostart", baseDir, Application.ExecutablePath);
        }
        catch (Exception error) { Log("设置开机启动失败：" + error.Message); }
    }

    private void CreateDesktopShortcut()
    {
        try
        {
            string link = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), DesktopPetLauncher2.Title + ".lnk");
            CreateShortcut(link, Application.ExecutablePath, "", baseDir, Application.ExecutablePath);
            Log("桌面快捷方式已创建");
        }
        catch (Exception error) { Log("创建快捷方式失败：" + error.Message); }
    }

    private static void CreateShortcut(string path, string target, string arguments, string workdir, string icon)
    {
        object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        object shortcut = shell.GetType().InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type type = shortcut.GetType();
        type.InvokeMember("TargetPath", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { target });
        type.InvokeMember("Arguments", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
        type.InvokeMember("WorkingDirectory", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { workdir });
        type.InvokeMember("IconLocation", System.Reflection.BindingFlags.SetProperty, null, shortcut, new object[] { icon + ",0" });
        type.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, shortcut, null);
    }

    private bool HasArg(string value)
    {
        return args.Any(a => string.Equals(a, value, StringComparison.OrdinalIgnoreCase));
    }

    private static string Short(string value, int max)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= max) return value ?? "";
        return value.Substring(0, max) + "…";
    }

    private static string Pad(string text, int width)
    {
        int visual = 0;
        foreach (char ch in text) visual += ch > 0x2E80 ? 2 : 1;
        return text + new string(' ', Math.Max(0, width - visual));
    }
}

internal static class DesktopPetLauncher2
{
    public const string Title = "gsd特制大肥鱼桌宠";
    public const string Sub = "会看屏幕陪你玩、会用自己的声音说话、还听得见你说话";
    public const int VoicePort = 8848;
    public static readonly Color Bg = Color.FromArgb(18, 22, 31);
    public static readonly Color PanelBg = Color.FromArgb(27, 33, 48);
    public static readonly Color InputBg = Color.FromArgb(15, 20, 32);
    public static readonly Color Accent = Color.FromArgb(78, 163, 255);
    public static readonly Color Muted = Color.FromArgb(143, 163, 191);
}
