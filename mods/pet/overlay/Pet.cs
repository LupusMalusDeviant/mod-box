// Mod Box Pet: a small always-on-top desktop companion that shows what Claude Code is doing in a
// speech bubble. It reads a status file the pet mod writes (key=value lines) and draws; when the
// status offers choices (Claude's question, the next-step suggestions), a click on one is written to
// <status file>.answer, which the mod picks up. No network, nothing else goes to Claude.
// Drag it anywhere; right-click for its menu, where "Figur" picks the figure and coat (written
// to the answer file with id "look"; the mod keeps it for the session or as the setting).
//
//   ModBoxPet.exe <status file> [bubble seconds]
//   ModBoxPet.exe --preview <file.png>      (every figure in every state, for a look)
//
// One pet per status file (a named mutex); a second start for it exits at once. Several pets (one
// per session) take free slots and stand side by side.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Mod Box Pet")]
[assembly: System.Reflection.AssemblyProduct("Mod Box")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace ModBox
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length < 1) return 2;
            if (args[0] == "--preview" && args.Length > 1) { Preview.Render(args[1]); return 0; }
            if (args[0] == "--preview-bubble" && args.Length > 1) { Preview.RenderBubble(args[1]); return 0; }
            bool isFirst;
            using (var mutex = new Mutex(true, "Local\\ModBoxPet-" + HashOf(args[0].ToLowerInvariant()), out isFirst))
            {
                if (!isFirst) return 0;
                // a free slot: where this pet stands next to the others
                Mutex slotMutex = null;
                int slot = 0;
                for (; slot < 8; slot++)
                {
                    bool isFree;
                    var m = new Mutex(true, "Local\\ModBoxPetSlot" + slot, out isFree);
                    if (isFree) { slotMutex = m; break; }
                    m.Dispose();
                }
                if (slotMutex == null) slot = 0;
                try
                {
                    Native.SetProcessDPIAware();
                    Application.EnableVisualStyles();
                    int seconds = 9;
                    if (args.Length > 1) int.TryParse(args[1], out seconds);
                    Application.Run(new PetWindow(args[0], Math.Max(3, Math.Min(60, seconds)), slot));
                }
                finally
                {
                    if (slotMutex != null) slotMutex.Dispose();
                }
            }
            return 0;
        }

        static string HashOf(string s)
        {
            unchecked
            {
                uint h = 2166136261;
                foreach (char c in s) { h ^= c; h *= 16777619; }
                return h.ToString("x8");
            }
        }
    }

    sealed class Status
    {
        public long At;
        public string Kind = "idle";
        public string Title = "";
        public string Text = "";
        public string Pet = "box";
        public string Fur = "auto";
        /// What a pick answers (Claude's question or the suggestions of one turn), and the choices.
        public string Ask = "";
        public List<string> Choices = new List<string>();

        public static Status Read(string path)
        {
            var s = new Status();
            foreach (var raw in File.ReadAllLines(path))
            {
                int eq = raw.IndexOf('=');
                if (eq <= 0) continue;
                string key = raw.Substring(0, eq), value = raw.Substring(eq + 1).Replace("\\n", "\n");
                if (key == "at") long.TryParse(value, out s.At);
                else if (key == "kind") s.Kind = value;
                else if (key == "title") s.Title = value;
                else if (key == "text") s.Text = value;
                else if (key == "pet") s.Pet = value;
                else if (key == "fur") s.Fur = value;
                else if (key == "ask") s.Ask = value;
                else if (key == "choice" && value.Length > 0) s.Choices.Add(value);
            }
            return s;
        }
    }

    sealed class PetWindow : Form
    {
        const int W = 340, H = 340, BODY = 64, BUTTON = 26;
        readonly string statusPath;
        readonly int bubbleMs;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly string posPath;
        readonly string answerPath;
        readonly int slot;
        readonly List<KeyValuePair<Rectangle, string>> buttons = new List<KeyValuePair<Rectangle, string>>();
        int hovered = -1;
        DateTime lastWrite = DateTime.MinValue;
        DateTime shownAt = DateTime.MinValue;
        DateTime lastNews = DateTime.Now;
        DateTime byeAt = DateTime.MaxValue;
        DateTime snoozeUntil = DateTime.MinValue;
        Status status = new Status { Kind = "hello", Text = "Hallo! Ich passe auf." };
        int tick;
        readonly Painter painter = new Painter();
        bool isBubble = true;
        Rectangle bubbleRect = Rectangle.Empty;

        public PetWindow(string statusPath, int bubbleSeconds, int slot)
        {
            this.statusPath = statusPath;
            this.slot = slot;
            answerPath = statusPath + ".answer";
            bubbleMs = bubbleSeconds * 1000;
            posPath = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath) ?? ".", "position-" + slot + ".txt");
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            Size = new Size(W, H);
            Location = StartLocation();
            shownAt = DateTime.Now;

            var menu = new ContextMenuStrip();
            menu.Items.Add("Blase ausblenden", null, (s, e) => { isBubble = false; Draw(); });
            menu.Items.Add("10 Minuten Ruhe", null, (s, e) => { snoozeUntil = DateTime.Now.AddMinutes(10); isBubble = false; Draw(); });
            menu.Items.Add("Zurück in die Ecke", null, (s, e) => { Location = CornerLocation(); SavePosition(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(FigureMenu());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Beenden", null, (s, e) => Close());
            ContextMenuStrip = menu;

            timer.Interval = 120;
            timer.Tick += (s, e) => OnTick();
            timer.Start();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= Native.WS_EX_LAYERED | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Draw();
        }

        Point CornerLocation()
        {
            var area = Screen.PrimaryScreen.WorkingArea;
            return new Point(area.Right - W - 24 - slot * (BODY + 46), area.Bottom - H - 8);
        }

        Point StartLocation()
        {
            try
            {
                var parts = File.ReadAllText(posPath).Split(',');
                var p = new Point(int.Parse(parts[0]), int.Parse(parts[1]));
                foreach (var screen in Screen.AllScreens)
                    if (screen.WorkingArea.IntersectsWith(new Rectangle(p, new Size(W, H)))) return p;
            }
            catch { }
            return CornerLocation();
        }

        void SavePosition()
        {
            try { File.WriteAllText(posPath, Location.X + "," + Location.Y); } catch { }
        }

        void OnTick()
        {
            tick++;
            try
            {
                var info = new FileInfo(statusPath);
                if (info.Exists && info.LastWriteTimeUtc != lastWrite)
                {
                    lastWrite = info.LastWriteTimeUtc;
                    var next = Status.Read(statusPath);
                    if (next.Text.Length > 0)
                    {
                        status = next;
                        lastNews = DateTime.Now;
                        if (DateTime.Now >= snoozeUntil || next.Kind == "error" || next.Kind == "ask")
                        {
                            isBubble = true;
                            shownAt = DateTime.Now;
                        }
                        if (next.Kind == "bye") byeAt = DateTime.Now.AddSeconds(4);
                    }
                }
            }
            catch { /* the mod is writing right now: next tick */ }

            if (DateTime.Now >= byeAt) { Close(); return; }
            // Two quiet hours: nobody needs the pet any more.
            if ((DateTime.Now - lastNews).TotalHours > 2) { Close(); return; }
            // Work keeps the bubble up; news fades after the set time, questions and errors stay.
            bool isSticky = status.Kind == "ask" || status.Kind == "error" || status.Choices.Count > 0;
            if (isBubble && !isSticky && status.Kind != "work" && (DateTime.Now - shownAt).TotalMilliseconds > bubbleMs) isBubble = false;
            if (isBubble && status.Kind == "work" && (DateTime.Now - shownAt).TotalMilliseconds > bubbleMs * 4) isBubble = false;
            Draw();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            if (isBubble)
                foreach (var bt in buttons)
                    if (bt.Key.Contains(e.Location)) { Pick(bt.Value); return; }
            if (isBubble && bubbleRect.Contains(e.Location) && e.Clicks == 2) { isBubble = false; Draw(); return; }
            Native.ReleaseCapture();
            Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
            SavePosition();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int over = -1;
            for (int i = 0; i < buttons.Count; i++) if (buttons[i].Key.Contains(e.Location)) over = i;
            if (over == hovered) return;
            hovered = over;
            Cursor = over >= 0 ? Cursors.Hand : Cursors.Default;
            Draw();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hovered < 0) return;
            hovered = -1;
            Cursor = Cursors.Default;
            Draw();
        }

        static readonly string[][] FigureNames = {
            new[] { "box", "Karton" }, new[] { "cat", "Katze" }, new[] { "dog", "Hund" }, new[] { "fox", "Fuchs" },
            new[] { "bunny", "Hase" }, new[] { "hamster", "Hamster" }, new[] { "owl", "Eule" }, new[] { "penguin", "Pinguin" },
            new[] { "frog", "Frosch" }, new[] { "axolotl", "Axolotl" }, new[] { "dragon", "Drache" }, new[] { "robot", "Roboter" },
            new[] { "ghost", "Geist" },
        };
        static readonly string[][] CoatNames = {
            new[] { "ginger", "rot getigert" }, new[] { "black", "schwarz" }, new[] { "white", "weiß" }, new[] { "grey", "grau getigert" },
            new[] { "brown", "braun getigert" }, new[] { "cream", "creme" }, new[] { "calico", "dreifarbig" }, new[] { "siamese", "Siam" },
            new[] { "tuxedo", "schwarz-weiß" },
        };

        // Right-click › Figur: every figure; cat, dog and bunny with their coats. Ticks show the current one.
        ToolStripMenuItem FigureMenu()
        {
            var root = new ToolStripMenuItem("Figur");
            foreach (var f in FigureNames)
            {
                string pet = f[0];
                var item = new ToolStripMenuItem(f[1]);
                if (pet == "cat" || pet == "dog" || pet == "bunny")
                {
                    foreach (var c in CoatNames)
                    {
                        string fur = c[0];
                        var coat = new ToolStripMenuItem(c[1], null, (s, e) => ChooseLook(pet, fur));
                        item.DropDownItems.Add(coat);
                    }
                    item.DropDownOpening += (s, e) => { foreach (ToolStripMenuItem c in item.DropDownItems) c.Checked = status.Pet == pet && CoatNames[item.DropDownItems.IndexOf(c)][0] == status.Fur; };
                }
                else item.Click += (s, e) => ChooseLook(pet, "auto");
                root.DropDownItems.Add(item);
            }
            root.DropDownItems.Add(new ToolStripSeparator());
            root.DropDownItems.Add(new ToolStripMenuItem("Zufall", null, (s, e) => ChooseLook("random", "")));
            root.DropDownOpening += (s, e) =>
            {
                foreach (var it in root.DropDownItems)
                {
                    var m = it as ToolStripMenuItem;
                    if (m == null) continue;
                    int at = Array.FindIndex(FigureNames, f => f[1] == m.Text);
                    m.Checked = at >= 0 && FigureNames[at][0] == status.Pet;
                }
            };
            return root;
        }

        // A figure from the menu: shown at once, written for the mod, which keeps it.
        void ChooseLook(string pet, string fur)
        {
            WriteAnswer("look", fur.Length > 0 ? pet + " " + fur : pet);
            if (pet != "random") { status.Pet = pet; status.Fur = fur; }
            Draw();
        }

        // Whole file at once (a temp file moved in place), so the mod never reads half of it.
        bool WriteAnswer(string id, string choice)
        {
            try
            {
                string tmp = answerPath + ".tmp";
                File.WriteAllText(tmp, "id=" + id + "\nchoice=" + choice.Replace("\r", "").Replace("\n", "\\n") + "\n");
                if (File.Exists(answerPath)) File.Delete(answerPath);
                File.Move(tmp, answerPath);
                return true;
            }
            catch { return false; }
        }

        // A choice was clicked: write it for the mod, show it as taken.
        void Pick(string choice)
        {
            if (!WriteAnswer(status.Ask, choice)) return;
            status = new Status { Kind = "work", Title = "\u2713", Text = choice, Pet = status.Pet, Fur = status.Fur };
            hovered = -1;
            Cursor = Cursors.Default;
            shownAt = DateTime.Now;
            isBubble = true;
            Draw();
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            // a click on the pet itself brings the last message back
            if (e.Button == MouseButtons.Left && !isBubble && e.Y > H - BODY - 30) { isBubble = true; shownAt = DateTime.Now; Draw(); }
        }

        Color Accent() { return painter.Accent(); }

        void Draw()
        {
            if (!IsHandleCreated) return;
            using (var bmp = Snapshot()) Native.Apply(this, bmp);
        }

        /// For the preview: Claude's question with three choices, the second under the pointer.
        public void ShowChoices()
        {
            status = new Status { Kind = "ask", Title = "shop · A question for you", Text = "Which database should the new service use?", Pet = "cat", Fur = "ginger", Ask = "q" };
            status.Choices.AddRange(new[] { "PostgreSQL (Recommended)", "SQLite", "Keep the JSON files" });
            hovered = 1;
            isBubble = true;
        }

        public Bitmap Snapshot()
        {
            var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    g.Clear(Color.Transparent);
                    int bob = (int)Math.Round(Math.Sin(tick / 6.0) * (status.Kind == "work" ? 3 : 1.5));
                    var body = new Rectangle(W - BODY - 18, H - BODY - 10 + bob, BODY, BODY);
                    painter.Kind = status.Kind; painter.Pet = status.Pet; painter.Fur = status.Fur; painter.Tick = tick;
                    if (isBubble) DrawBubble(g, body);
                    else { bubbleRect = Rectangle.Empty; buttons.Clear(); }
                    painter.Paint(g, body);
                }
            }
            return bmp;
        }

        void DrawBubble(Graphics g, Rectangle body)
        {
            string title = status.Title, text = status.Text;
            using (var titleFont = new Font("Segoe UI Semibold", 9f))
            using (var font = new Font("Segoe UI", 10f))
            {
                int maxW = W - 24;
                var textSize = g.MeasureString(text, font, maxW - 24);
                var titleSize = title.Length > 0 ? g.MeasureString(title, titleFont, maxW - 24) : SizeF.Empty;
                int n = status.Choices.Count;
                int choicesH = n == 0 ? 0 : n * (BUTTON + 5) + 4;
                int bw = (int)Math.Min(maxW, Math.Max(Math.Max(textSize.Width, titleSize.Width) + 26, n > 0 ? 240 : 0));
                int head = painter.Headroom();
                int bh = (int)Math.Min(H - BODY - 30 - head, textSize.Height + titleSize.Height + 20 + choicesH);
                var r = new Rectangle(W - bw - 8, body.Top - bh - 14 - head, bw, bh);
                bubbleRect = r;
                using (var path = Rounded(r, 12))
                {
                    // tail towards the pet
                    var tail = new[] { new Point(body.Left + 20, r.Bottom - 1), new Point(body.Left + 36, r.Bottom - 1), new Point(body.Left + 26, body.Top - head) };
                    using (var shadow = new SolidBrush(Color.FromArgb(50, 0, 0, 0)))
                    {
                        var s = r; s.Offset(2, 3);
                        using (var sp = Rounded(s, 12)) g.FillPath(shadow, sp);
                    }
                    using (var fill = new SolidBrush(Color.FromArgb(250, 252, 252, 250)))
                    {
                        g.FillPath(fill, path);
                        g.FillPolygon(fill, tail);
                    }
                    using (var pen = new Pen(Accent(), 2f))
                    {
                        g.DrawPath(pen, path);
                        g.DrawLine(pen, tail[0], tail[2]);
                        g.DrawLine(pen, tail[1], tail[2]);
                    }
                    using (var fill = new SolidBrush(Color.FromArgb(250, 252, 252, 250)))
                        g.FillRectangle(fill, tail[0].X + 2, r.Bottom - 2, tail[1].X - tail[0].X - 3, 3);
                }
                float y = r.Top + 9;
                if (title.Length > 0)
                {
                    using (var b = new SolidBrush(Accent())) g.DrawString(title, titleFont, b, new RectangleF(r.Left + 12, y, r.Width - 22, titleSize.Height));
                    y += titleSize.Height;
                }
                using (var b = new SolidBrush(Color.FromArgb(40, 40, 46)))
                    g.DrawString(text, font, b, new RectangleF(r.Left + 12, y, r.Width - 22, r.Bottom - y - 6 - choicesH), new StringFormat { Trimming = StringTrimming.EllipsisWord });
                // the choices, one button each, numbered
                buttons.Clear();
                var accent = Accent();
                int by = r.Bottom - choicesH;
                using (var label = new Font("Segoe UI", 9f))
                    for (int i = 0; i < n; i++)
                    {
                        var rect = new Rectangle(r.Left + 10, by + i * (BUTTON + 5), r.Width - 20, BUTTON);
                        buttons.Add(new KeyValuePair<Rectangle, string>(rect, status.Choices[i]));
                        bool isOver = i == hovered;
                        using (var path = Rounded(rect, 7))
                        using (var fill = new SolidBrush(isOver ? accent : Color.FromArgb(40, accent)))
                        using (var pen = new Pen(accent, 1.4f))
                        {
                            g.FillPath(fill, path);
                            g.DrawPath(pen, path);
                        }
                        using (var ink = new SolidBrush(isOver ? Color.White : Color.FromArgb(40, 40, 46)))
                            g.DrawString((i + 1) + "  " + status.Choices[i], label, ink, new RectangleF(rect.Left + 8, rect.Top + 4, rect.Width - 14, rect.Height - 4), new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap });
                    }
            }
        }

        static GraphicsPath Rounded(Rectangle r, int radius)
        {
            int d = radius * 2;
            var p = new GraphicsPath();
            p.AddArc(r.Left, r.Top, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            SavePosition();
            timer.Stop();
            base.OnFormClosed(e);
        }
    }

    // The figures. Each draws into a 64 x 64 body box (ears, antennas and tails may reach past it)
    // and shows the status the same way: the accent colour on a collar, scarf, bow or light, the
    // face (happy squint when done, blink now and then, eyes wander while working, a frown on an
    // error, an "o" on a question) and a small head tilt while it waits for an answer.
    sealed class Painter
    {
        public static readonly string[] Pets = { "box", "cat", "dog", "fox", "bunny", "hamster", "owl", "penguin", "frog", "axolotl", "dragon", "robot", "ghost" };
        public static readonly string[] Furs = { "ginger", "black", "white", "grey", "brown", "cream", "calico", "siamese", "tuxedo" };

        public string Kind = "hello";
        public string Pet = "box";
        public string Fur = "auto";
        public int Tick;

        bool IsWork { get { return Kind == "work"; } }

        public Color Accent()
        {
            switch (Kind)
            {
                case "error": return Color.FromArgb(230, 90, 80);
                case "done": return Color.FromArgb(80, 190, 120);
                case "ask": return Color.FromArgb(240, 180, 60);
                case "work": return Color.FromArgb(90, 150, 240);
                case "cold": return Color.FromArgb(110, 196, 222);
                default: return Color.FromArgb(215, 120, 80);
            }
        }

        /// Extra room above the body box the bubble leaves free (long ears, antennas).
        public int Headroom()
        {
            switch (Pet)
            {
                case "bunny": return 22;
                case "robot": return 12;
                case "dragon": return 6;
                default: return 4;
            }
        }

        public void Paint(Graphics g, Rectangle b)
        {
            if (Pet == "ghost")
                using (var glow = new SolidBrush(Color.FromArgb(90, Accent()))) g.FillEllipse(glow, b.Left + 4, b.Bottom - 2, b.Width - 8, 12);
            else
                using (var shadow = new SolidBrush(Color.FromArgb(60, 0, 0, 0))) g.FillEllipse(shadow, b.Left + 6, b.Bottom - 4, b.Width - 12, 10);
            var state = g.Save();
            if (Kind == "ask")
            {
                g.TranslateTransform(b.Left + b.Width / 2f, b.Bottom);
                g.RotateTransform(-7f);
                g.TranslateTransform(-(b.Left + b.Width / 2f), -b.Bottom);
            }
            switch (Pet)
            {
                case "cat": Cat(g, b); break;
                case "dog": Dog(g, b); break;
                case "fox": Fox(g, b); break;
                case "bunny": Bunny(g, b); break;
                case "hamster": Hamster(g, b); break;
                case "owl": Owl(g, b); break;
                case "penguin": Penguin(g, b); break;
                case "frog": Frog(g, b); break;
                case "axolotl": Axolotl(g, b); break;
                case "dragon": Dragon(g, b); break;
                case "robot": Robot(g, b); break;
                case "ghost": Ghost(g, b); break;
                default: Box(g, b); break;
            }
            g.Restore(state);
        }

        // ------------------------------------------------------------ shared pieces

        static Color C(int r, int g, int b) { return Color.FromArgb(r, g, b); }
        static PointF P(float x, float y) { return new PointF(x, y); }
        static Color Shade(Color c, double f) { return Color.FromArgb(c.A, Math.Min(255, (int)(c.R * f)), Math.Min(255, (int)(c.G * f)), Math.Min(255, (int)(c.B * f))); }
        static readonly Color Ink = C(60, 40, 30);
        static readonly Color Pink = C(240, 150, 160);

        static void Oval(Graphics g, Color fill, Color line, float w, float x, float y, float ww, float hh)
        {
            using (var br = new SolidBrush(fill)) g.FillEllipse(br, x, y, ww, hh);
            if (w > 0) using (var pen = new Pen(line, w)) g.DrawEllipse(pen, x, y, ww, hh);
        }

        static void Poly(Graphics g, Color fill, Color line, float w, params PointF[] pts)
        {
            using (var br = new SolidBrush(fill)) g.FillPolygon(br, pts);
            if (w > 0) using (var pen = new Pen(line, w) { LineJoin = LineJoin.Round }) g.DrawPolygon(pen, pts);
        }

        static void Shape(Graphics g, Color fill, Color line, float w, GraphicsPath path)
        {
            using (var br = new SolidBrush(fill)) g.FillPath(br, path);
            if (w > 0) using (var pen = new Pen(line, w) { LineJoin = LineJoin.Round }) g.DrawPath(pen, path);
        }

        static Pen Round(Color c, float w) { return new Pen(c, w) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round }; }

        static void Curve(Graphics g, Color line, Color fill, float w, PointF a, PointF b, PointF c, PointF d)
        {
            using (var pen = Round(line, w + 3)) g.DrawBezier(pen, a, b, c, d);
            using (var pen = Round(fill, w)) g.DrawBezier(pen, a, b, c, d);
        }

        static GraphicsPath RoundRect(RectangleF r, float radius)
        {
            float d = radius * 2;
            var p = new GraphicsPath();
            p.AddArc(r.Left, r.Top, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Top, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        /// Draws in a frame turned by deg around (x, y); the action works in that frame, (0,0) at the pivot.
        static void Turned(Graphics g, float x, float y, float deg, Action act)
        {
            var st = g.Save();
            g.TranslateTransform(x, y);
            g.RotateTransform(deg);
            act();
            g.Restore(st);
        }

        float Swing(double slow, double fast) { return (float)Math.Sin(Tick / (IsWork ? fast : slow)); }

        /// Eyes and mouth for the status. iris: coloured eyes with a pupil (Empty = plain dots).
        /// mouth: "smile", "cat" (a small w), "wide" or "none" (a beak draws its own).
        void Face(Graphics g, float lx, float rx, float ey, float mx, float my, Color ink, Color iris, float er, string mouth, bool isSlit)
        {
            bool isBlink = Tick % 40 == 0 || Tick % 40 == 1;
            using (var pen = Round(ink, 2.4f))
            using (var dot = new SolidBrush(ink))
            {
                if (Kind == "done")
                {
                    g.DrawArc(pen, lx - er - 1, ey - 2, 2 * er + 2, 2 * er, 200, 140);
                    g.DrawArc(pen, rx - er - 1, ey - 2, 2 * er + 2, 2 * er, 200, 140);
                }
                else if (isBlink)
                {
                    g.DrawLine(pen, lx - er, ey + 1, lx + er, ey + 1);
                    g.DrawLine(pen, rx - er, ey + 1, rx + er, ey + 1);
                }
                else
                {
                    float look = IsWork ? (float)Math.Round(Math.Sin(Tick / 8.0) * 2) : 0;
                    foreach (var x in new[] { lx, rx })
                    {
                        if (iris != Color.Empty)
                        {
                            using (var ib = new SolidBrush(iris)) g.FillEllipse(ib, x - er, ey - er, 2 * er, 2 * er + 1);
                            using (var pb = new SolidBrush(C(25, 22, 20)))
                            {
                                if (isSlit) g.FillEllipse(pb, x - er * 0.3f + look * 0.5f, ey - er + 1, er * 0.6f, 2 * er - 1);
                                else g.FillEllipse(pb, x - er * 0.55f + look * 0.5f, ey - er * 0.5f, er * 1.1f, er * 1.2f);
                            }
                        }
                        else g.FillEllipse(dot, x - er + look, ey - er, 2 * er, 2 * er + 1);
                        using (var shine = new SolidBrush(Color.White)) g.FillEllipse(shine, x - er * 0.5f + look, ey - er * 0.75f, er * 0.75f, er * 0.75f);
                    }
                }
                if (Kind == "error") g.DrawArc(pen, mx - 7, my + 1, 14, 8, 200, 140);
                else if (Kind == "ask") g.DrawEllipse(pen, mx - 3, my - 1, 6, 7);
                else if (mouth == "cat")
                {
                    g.DrawArc(pen, mx - 6, my - 3, 6, 5, 0, 180);
                    g.DrawArc(pen, mx, my - 3, 6, 5, 0, 180);
                }
                else if (mouth == "wide") g.DrawArc(pen, mx - 13, my - 8, 26, 12, 20, 140);
                else if (mouth == "smile") g.DrawArc(pen, mx - 7, my - 6, 14, 10, 20, 140);
            }
        }

        static void Blush(Graphics g, float lx, float rx, float y)
        {
            using (var blush = new SolidBrush(Color.FromArgb(70, 230, 110, 110)))
            {
                g.FillEllipse(blush, lx - 10, y, 9, 5);
                g.FillEllipse(blush, rx + 1, y, 9, 5);
            }
        }

        void Collar(Graphics g, float x, float y, float w, bool hasBell)
        {
            using (var pen = Round(Accent(), 3.2f)) g.DrawArc(pen, x, y - 6, w, 12, 25, 130);
            if (hasBell) Oval(g, C(245, 205, 80), C(170, 130, 40), 1.2f, x + w / 2 - 3.5f, y + 4, 7, 7);
        }

        void Bow(Graphics g, float cx, float cy, float size)
        {
            var a = Accent();
            Poly(g, a, Shade(a, 0.7), 1.2f, P(cx, cy), P(cx - size, cy - size * 0.6f), P(cx - size, cy + size * 0.6f));
            Poly(g, a, Shade(a, 0.7), 1.2f, P(cx, cy), P(cx + size, cy - size * 0.6f), P(cx + size, cy + size * 0.6f));
            Oval(g, Shade(a, 0.85), Shade(a, 0.7), 1f, cx - 2.5f, cy - 2.5f, 5, 5);
        }

        // ------------------------------------------------------------ coats (fur colours)

        sealed class Coat
        {
            public Color Main, Line, Light, Point, Patch1, Patch2;
            public string Pattern = "";
            public bool IsDark;
        }

        static Coat CoatOf(string fur, string fallback)
        {
            if (string.IsNullOrEmpty(fur) || fur == "auto" || Array.IndexOf(Furs, fur) < 0) fur = fallback;
            var c = new Coat();
            switch (fur)
            {
                case "black": c.Main = C(58, 58, 66); c.Line = C(25, 25, 30); c.Light = C(95, 95, 106); c.IsDark = true; break;
                case "white": c.Main = C(248, 246, 241); c.Line = C(165, 160, 155); c.Light = C(255, 255, 255); break;
                case "grey": c.Main = C(165, 170, 180); c.Line = C(95, 100, 112); c.Light = C(222, 225, 230); c.Pattern = "tabby"; break;
                case "brown": c.Main = C(160, 112, 72); c.Line = C(95, 60, 35); c.Light = C(228, 196, 158); c.Pattern = "tabby"; break;
                case "cream": c.Main = C(242, 222, 184); c.Line = C(175, 145, 100); c.Light = C(253, 246, 230); break;
                case "calico": c.Main = C(250, 247, 240); c.Line = C(160, 150, 140); c.Light = C(255, 255, 255); c.Patch1 = C(232, 145, 70); c.Patch2 = C(60, 58, 62); c.Pattern = "calico"; break;
                case "siamese": c.Main = C(240, 228, 208); c.Line = C(150, 125, 100); c.Light = C(252, 246, 236); c.Point = C(92, 66, 50); c.Pattern = "points"; break;
                case "tuxedo": c.Main = C(50, 50, 58); c.Line = C(22, 22, 28); c.Light = C(250, 250, 248); c.IsDark = true; c.Pattern = "tuxedo"; break;
                default: c.Main = C(238, 152, 72); c.Line = C(165, 88, 35); c.Light = C(252, 226, 192); c.Pattern = "tabby"; break; // ginger
            }
            if (c.Point.IsEmpty) c.Point = c.Main;
            return c;
        }

        static Color FaceInk(Coat c) { return c.IsDark ? C(232, 230, 222) : Ink; }

        // ------------------------------------------------------------ the figures

        // The Mod Box itself: a little cardboard box with a face.
        void Box(Graphics g, Rectangle b)
        {
            var accent = Accent();
            using (var path = RoundRect(new RectangleF(b.Left, b.Top + 10, b.Width, b.Height - 10), 10))
            using (var fill = new LinearGradientBrush(b, C(236, 196, 140), C(205, 155, 95), 90f))
            using (var pen = new Pen(C(150, 100, 55), 2f))
            {
                g.FillPath(fill, path);
                g.DrawPath(pen, path);
            }
            // lid flaps, a little open while working
            float open = IsWork ? (float)(Math.Abs(Math.Sin(Tick / 3.0)) * 6) : 0;
            float mid = b.Left + b.Width / 2f;
            Poly(g, C(222, 175, 115), C(150, 100, 55), 2f, P(b.Left - 2, b.Top + 12), P(mid, b.Top + 12), P(mid - 4, b.Top + 2 - open), P(b.Left + 4, b.Top + 4 - open));
            Poly(g, C(222, 175, 115), C(150, 100, 55), 2f, P(b.Right + 2, b.Top + 12), P(mid, b.Top + 12), P(mid + 4, b.Top + 2 - open), P(b.Right - 4, b.Top + 4 - open));
            // a strip of tape in the status colour
            using (var tape = new SolidBrush(Color.FromArgb(200, accent))) g.FillRectangle(tape, mid - 5, b.Top + 12, 10, 12);
            Face(g, b.Left + 20, b.Right - 20, b.Top + 34, mid, b.Top + 48, Ink, Color.Empty, 4, "smile", false);
            Blush(g, b.Left + 20, b.Right - 20, b.Top + 42);
        }

        void Cat(Graphics g, Rectangle b)
        {
            var c = CoatOf(Fur, "ginger");
            float cx = b.Left + 32, sw = Swing(5, 2);
            var tail = c.Pattern == "points" ? c.Point : c.Main;
            Curve(g, c.Line, tail, 6, P(b.Right - 14, b.Bottom - 6), P(b.Right + 8, b.Bottom - 2), P(b.Right + 12 + sw * 3, b.Top + 34), P(b.Right + 2 + sw * 8, b.Top + 22));
            // body, chest, paws
            Oval(g, c.Main, c.Line, 2, b.Left + 9, b.Top + 30, 46, 34);
            if (c.Pattern == "calico")
            {
                Oval(g, c.Patch1, c.Patch1, 0, b.Left + 12, b.Top + 44, 14, 12);
                Oval(g, c.Patch2, c.Patch2, 0, b.Left + 38, b.Top + 40, 12, 10);
            }
            if (c.Pattern == "tuxedo") Oval(g, c.Light, c.Light, 0, cx - 9, b.Top + 38, 18, 22);
            var paw = c.Pattern == "points" ? c.Point : c.Pattern == "tuxedo" ? c.Light : c.Main;
            Oval(g, paw, c.Line, 1.6f, b.Left + 17, b.Bottom - 9, 12, 9);
            Oval(g, paw, c.Line, 1.6f, b.Left + 35, b.Bottom - 9, 12, 9);
            // ears: up on a question, flat on an error, a twitch now and then while working
            float up = Kind == "ask" ? 5 : 0, flat = Kind == "error" ? 1 : 0, tw = IsWork && (Tick / 4) % 6 == 0 ? 3 : 0;
            var ear = c.Pattern == "points" ? c.Point : c.Main;
            var l = new[] { P(b.Left + 9, b.Top + 18), P(b.Left + 28, b.Top + 8), P(b.Left + 10 - flat * 6, b.Top - 4 - up + tw + flat * 12) };
            var r = new[] { P(b.Right - 9, b.Top + 18), P(b.Right - 28, b.Top + 8), P(b.Right - 10 + flat * 6, b.Top - 4 - up + flat * 12) };
            Poly(g, ear, c.Line, 2, l);
            Poly(g, ear, c.Line, 2, r);
            Poly(g, Pink, Pink, 0, Inner(l, 0.55f));
            Poly(g, Pink, Pink, 0, Inner(r, 0.55f));
            // head and its markings
            Oval(g, c.Main, c.Line, 2, b.Left + 6, b.Top + 4, 52, 40);
            if (c.Pattern == "tabby")
                using (var pen = Round(Color.FromArgb(150, c.Line), 2.2f))
                {
                    g.DrawLine(pen, cx - 7, b.Top + 7, cx - 5, b.Top + 13);
                    g.DrawLine(pen, cx, b.Top + 6, cx, b.Top + 14);
                    g.DrawLine(pen, cx + 7, b.Top + 7, cx + 5, b.Top + 13);
                    g.DrawLine(pen, b.Left + 8, b.Top + 26, b.Left + 14, b.Top + 27);
                    g.DrawLine(pen, b.Right - 8, b.Top + 26, b.Right - 14, b.Top + 27);
                }
            if (c.Pattern == "calico")
            {
                Oval(g, c.Patch1, c.Patch1, 0, b.Left + 11, b.Top + 7, 18, 13);
                Oval(g, c.Patch2, c.Patch2, 0, b.Right - 25, b.Top + 8, 14, 11);
            }
            if (c.Pattern == "points") Oval(g, Color.FromArgb(210, c.Point), c.Point, 0, cx - 12, b.Top + 21, 24, 19);
            if (c.Pattern == "tuxedo") Oval(g, c.Light, c.Light, 0, cx - 11, b.Top + 25, 22, 16);
            Collar(g, b.Left + 15, b.Top + 41, 34, true);
            var ink = FaceInk(c);
            var eye = c.IsDark || c.Pattern == "points" ? (c.Pattern == "points" ? C(110, 170, 235) : C(196, 214, 92)) : Color.Empty;
            Face(g, cx - 11, cx + 11, b.Top + 21, cx, b.Top + 32, c.Pattern == "tuxedo" ? Ink : ink, eye, 4.2f, "cat", true);
            Poly(g, Pink, Shade(Pink, 0.8), 1, P(cx - 3, b.Top + 27), P(cx + 3, b.Top + 27), P(cx, b.Top + 30));
            using (var pen = new Pen(Color.FromArgb(150, c.IsDark && c.Pattern != "tuxedo" ? C(220, 220, 215) : C(90, 80, 75)), 1f))
            {
                g.DrawLine(pen, cx - 8, b.Top + 30, b.Left - 2, b.Top + 27);
                g.DrawLine(pen, cx - 8, b.Top + 32, b.Left - 1, b.Top + 33);
                g.DrawLine(pen, cx + 8, b.Top + 30, b.Right + 2, b.Top + 27);
                g.DrawLine(pen, cx + 8, b.Top + 32, b.Right + 1, b.Top + 33);
            }
            if (!c.IsDark) Blush(g, cx - 11, cx + 11, b.Top + 28);
        }

        static PointF[] Inner(PointF[] tri, float f)
        {
            float mx = (tri[0].X + tri[1].X + tri[2].X) / 3, my = (tri[0].Y + tri[1].Y + tri[2].Y) / 3;
            var o = new PointF[3];
            for (int i = 0; i < 3; i++) o[i] = P(mx + (tri[i].X - mx) * f, my + (tri[i].Y - my) * f + 1);
            return o;
        }

        void Dog(Graphics g, Rectangle b)
        {
            var c = CoatOf(Fur, "brown");
            float cx = b.Left + 32;
            float wag = (float)Math.Sin(Tick / (IsWork || Kind == "done" ? 1.2 : 4.0));
            Curve(g, c.Line, c.Pattern == "points" ? c.Point : c.Main, 5, P(b.Right - 12, b.Bottom - 14), P(b.Right + 2, b.Bottom - 16), P(b.Right + 8 + wag * 6, b.Top + 34), P(b.Right + 4 + wag * 10, b.Top + 24));
            Oval(g, c.Main, c.Line, 2, b.Left + 9, b.Top + 32, 46, 32);
            Oval(g, c.Light, c.Light, 0, cx - 9, b.Top + 40, 18, 20);
            Oval(g, c.Pattern == "tuxedo" ? c.Light : c.Main, c.Line, 1.6f, b.Left + 16, b.Bottom - 9, 13, 9);
            Oval(g, c.Pattern == "tuxedo" ? c.Light : c.Main, c.Line, 1.6f, b.Left + 35, b.Bottom - 9, 13, 9);
            Oval(g, c.Main, c.Line, 2, b.Left + 8, b.Top + 2, 48, 42);
            if (c.Pattern == "calico") Oval(g, c.Patch1, c.Patch1, 0, b.Left + 13, b.Top + 9, 19, 17);
            // floppy ears: flap while working, perk up on a question
            var ear = c.Pattern == "points" || c.Pattern == "calico" ? (c.Pattern == "calico" ? c.Patch1 : c.Point) : Shade(c.Main, 0.78);
            float flap = IsWork ? wag * 10 : 0, perk = Kind == "ask" ? -30 : 0;
            Turned(g, b.Left + 13, b.Top + 8, 18 + flap + perk, () => Oval(g, ear, c.Line, 1.8f, -7, -3, 14, 30));
            Turned(g, b.Right - 13, b.Top + 8, -18 - flap - perk, () => Oval(g, ear, c.Line, 1.8f, -7, -3, 14, 30));
            Oval(g, c.Light, Shade(c.Light, 0.85), 1, cx - 12, b.Top + 23, 24, 18);
            var ink = c.IsDark && c.Pattern != "tuxedo" ? FaceInk(c) : Ink;
            Face(g, cx - 11, cx + 11, b.Top + 18, cx, b.Top + 34, ink, Color.Empty, 4, "smile", false);
            Oval(g, C(40, 32, 30), C(40, 32, 30), 0, cx - 5, b.Top + 24, 10, 7);
            using (var shine = new SolidBrush(Color.FromArgb(180, 255, 255, 255))) g.FillEllipse(shine, cx - 3, b.Top + 25, 3, 2);
            if (Kind == "done" || Kind == "hello")
                using (var path = RoundRect(new RectangleF(cx - 4, b.Top + 33, 8, 9), 3)) Shape(g, C(240, 120, 135), C(200, 85, 100), 1, path);
            Collar(g, b.Left + 15, b.Top + 43, 34, false);
            Oval(g, C(245, 205, 80), C(170, 130, 40), 1, cx - 3.5f, b.Top + 46, 7, 7);
            if (!c.IsDark) Blush(g, cx - 11, cx + 11, b.Top + 25);
        }

        void Fox(Graphics g, Rectangle b)
        {
            Color main = C(234, 122, 50), line = C(160, 72, 25), white = C(252, 247, 238), dark = C(62, 44, 38);
            float cx = b.Left + 32, sw = Swing(5, 2.2);
            Turned(g, b.Right - 8, b.Bottom - 6, 40 + sw * 10, () =>
            {
                Oval(g, main, line, 2, -10, -40, 20, 42);
                Oval(g, white, white, 0, -6, -42, 12, 13);
            });
            Oval(g, main, line, 2, b.Left + 10, b.Top + 32, 44, 32);
            Oval(g, white, white, 0, cx - 9, b.Top + 38, 18, 22);
            Oval(g, dark, dark, 0, b.Left + 17, b.Bottom - 8, 12, 8);
            Oval(g, dark, dark, 0, b.Left + 35, b.Bottom - 8, 12, 8);
            float up = Kind == "ask" ? 4 : 0, flat = Kind == "error" ? 1 : 0;
            var l = new[] { P(b.Left + 8, b.Top + 20), P(b.Left + 28, b.Top + 10), P(b.Left + 8 - flat * 6, b.Top - 6 - up + flat * 12) };
            var r = new[] { P(b.Right - 8, b.Top + 20), P(b.Right - 28, b.Top + 10), P(b.Right - 8 + flat * 6, b.Top - 6 - up + flat * 12) };
            Poly(g, main, line, 2, l);
            Poly(g, main, line, 2, r);
            Poly(g, dark, dark, 0, l[2], P(l[2].X + (l[0].X - l[2].X) * 0.35f, l[2].Y + (l[0].Y - l[2].Y) * 0.35f), P(l[2].X + (l[1].X - l[2].X) * 0.35f, l[2].Y + (l[1].Y - l[2].Y) * 0.35f));
            Poly(g, dark, dark, 0, r[2], P(r[2].X + (r[0].X - r[2].X) * 0.35f, r[2].Y + (r[0].Y - r[2].Y) * 0.35f), P(r[2].X + (r[1].X - r[2].X) * 0.35f, r[2].Y + (r[1].Y - r[2].Y) * 0.35f));
            Oval(g, main, line, 2, b.Left + 5, b.Top + 6, 54, 38);
            // white cheeks meeting at the chin
            Poly(g, white, white, 0, P(b.Left + 7, b.Top + 26), P(cx, b.Top + 43), P(b.Right - 7, b.Top + 26), P(cx, b.Top + 30));
            Oval(g, dark, dark, 0, cx - 3.5f, b.Top + 29, 7, 5);
            Face(g, cx - 12, cx + 12, b.Top + 21, cx, b.Top + 37, Ink, Color.Empty, 4, "cat", false);
            // a bandana in the status colour
            var a = Accent();
            Poly(g, a, Shade(a, 0.7), 1.4f, P(b.Left + 16, b.Top + 41), P(b.Right - 16, b.Top + 41), P(cx, b.Top + 54));
            Blush(g, cx - 12, cx + 12, b.Top + 28);
        }

        void Bunny(Graphics g, Rectangle b)
        {
            var c = CoatOf(Fur, "white");
            float cx = b.Left + 32, sw = Swing(6, 1.6);
            Oval(g, c.Light, c.Line, 1.4f, b.Right - 12, b.Bottom - 22, 15, 14); // tail
            Oval(g, c.Main, c.Line, 2, b.Left + 10, b.Top + 32, 44, 32);
            if (c.Pattern == "tuxedo") Oval(g, c.Light, c.Light, 0, cx - 9, b.Top + 38, 18, 22);
            Oval(g, c.Pattern == "points" ? c.Point : c.Main, c.Line, 1.6f, b.Left + 16, b.Bottom - 8, 14, 8);
            Oval(g, c.Pattern == "points" ? c.Point : c.Main, c.Line, 1.6f, b.Left + 34, b.Bottom - 8, 14, 8);
            // long ears: straight up on a question, one droops on an error, a twitch while working
            var ear = c.Pattern == "points" ? c.Point : c.Pattern == "calico" ? c.Patch2 : c.Main;
            float tall = Kind == "ask" ? 4 : 0;
            float left = Kind == "error" ? -75 : -12 + (IsWork ? sw * 6 : 0), right = 12 - (IsWork ? sw * 6 : 0);
            Turned(g, cx - 9, b.Top + 10, left, () => { Oval(g, ear, c.Line, 2, -6.5f, -32 - tall, 13, 36 + tall); Oval(g, Pink, Pink, 0, -3, -27 - tall, 6, 26 + tall); });
            Turned(g, cx + 9, b.Top + 10, right, () => { Oval(g, ear, c.Line, 2, -6.5f, -32 - tall, 13, 36 + tall); Oval(g, Pink, Pink, 0, -3, -27 - tall, 6, 26 + tall); });
            Oval(g, c.Main, c.Line, 2, b.Left + 8, b.Top + 6, 48, 38);
            if (c.Pattern == "calico") Oval(g, c.Patch1, c.Patch1, 0, b.Right - 26, b.Top + 9, 16, 13);
            if (c.Pattern == "points") Oval(g, Color.FromArgb(200, c.Point), c.Point, 0, cx - 10, b.Top + 24, 20, 15);
            if (c.Pattern == "tuxedo") Oval(g, c.Light, c.Light, 0, cx - 11, b.Top + 25, 22, 15);
            Bow(g, cx, b.Top + 7, 7);
            var ink = c.IsDark && c.Pattern != "tuxedo" ? FaceInk(c) : Ink;
            Face(g, cx - 11, cx + 11, b.Top + 22, cx, b.Top + 33, ink, Color.Empty, 4, "cat", false);
            Oval(g, Pink, Shade(Pink, 0.8), 1, cx - 3, b.Top + 27, 6, 4);
            if (Kind != "error" && Kind != "ask")
                using (var path = RoundRect(new RectangleF(cx - 3, b.Top + 34, 6, 5), 1.5f)) Shape(g, Color.White, C(170, 165, 160), 1, path);
            if (!c.IsDark) Blush(g, cx - 11, cx + 11, b.Top + 29);
        }

        void Hamster(Graphics g, Rectangle b)
        {
            Color main = C(236, 172, 96), line = C(160, 105, 50), white = C(253, 244, 228);
            float cx = b.Left + 32;
            // one round ball, cheeks puffed while working (stuffing them with work)
            float puff = IsWork ? (float)(Math.Abs(Math.Sin(Tick / 3.0)) * 3) : 0;
            Oval(g, main, line, 2, b.Left + 4, b.Top + 8, 56, 56);
            Oval(g, white, white, 0, b.Left + 14, b.Top + 34, 36, 28);
            Oval(g, C(230, 160, 85), line, 1.8f, b.Left + 9, b.Top + 6, 14, 13);
            Oval(g, C(230, 160, 85), line, 1.8f, b.Right - 23, b.Top + 6, 14, 13);
            Oval(g, Pink, Pink, 0, b.Left + 12, b.Top + 9, 8, 7);
            Oval(g, Pink, Pink, 0, b.Right - 20, b.Top + 9, 8, 7);
            Oval(g, white, Shade(white, 0.85), 1, b.Left + 7 - puff, b.Top + 26 - puff / 2, 18 + puff, 15 + puff);
            Oval(g, white, Shade(white, 0.85), 1, b.Right - 25, b.Top + 26 - puff / 2, 18 + puff, 15 + puff);
            Oval(g, Pink, Pink, 0, b.Left + 20, b.Bottom - 8, 9, 6);
            Oval(g, Pink, Pink, 0, b.Left + 35, b.Bottom - 8, 9, 6);
            // a sunflower seed held in the paws, in the status colour
            var a = Accent();
            Oval(g, a, Shade(a, 0.65), 1.4f, cx - 4, b.Top + 40, 8, 12);
            Oval(g, Pink, Pink, 0, cx - 9, b.Top + 44, 7, 6);
            Oval(g, Pink, Pink, 0, cx + 2, b.Top + 44, 7, 6);
            Face(g, cx - 10, cx + 10, b.Top + 23, cx, b.Top + 33, Ink, Color.Empty, 3.6f, "cat", false);
            Oval(g, Pink, Shade(Pink, 0.8), 1, cx - 2.5f, b.Top + 27, 5, 4);
            Blush(g, cx - 12, cx + 12, b.Top + 29);
        }

        void Owl(Graphics g, Rectangle b)
        {
            Color main = C(150, 105, 66), line = C(88, 58, 34), belly = C(228, 204, 165), disc = C(246, 240, 226);
            float cx = b.Left + 32, flap = IsWork ? Swing(6, 1.5) * 16 : 0;
            Turned(g, b.Left + 10, b.Top + 28, 10 + flap, () => Oval(g, Shade(main, 0.85), line, 1.8f, -6, -2, 13, 30));
            Turned(g, b.Right - 10, b.Top + 28, -10 - flap, () => Oval(g, Shade(main, 0.85), line, 1.8f, -7, -2, 13, 30));
            Poly(g, main, line, 2, P(b.Left + 9, b.Top + 14), P(b.Left + 20, b.Top + 6), P(b.Left + 9, b.Top - 3));
            Poly(g, main, line, 2, P(b.Right - 9, b.Top + 14), P(b.Right - 20, b.Top + 6), P(b.Right - 9, b.Top - 3));
            Oval(g, main, line, 2, b.Left + 7, b.Top + 2, 50, 62);
            Oval(g, belly, belly, 0, b.Left + 17, b.Top + 30, 30, 30);
            using (var pen = Round(Color.FromArgb(140, line), 1.4f))
                for (int row = 0; row < 3; row++)
                    for (int col = 0; col < 3 - row % 2; col++)
                        g.DrawArc(pen, b.Left + 21 + col * 8 + (row % 2) * 4, b.Top + 40 + row * 6, 6, 4, 20, 140);
            Oval(g, disc, Shade(disc, 0.8), 1.4f, cx - 22, b.Top + 9, 21, 21);
            Oval(g, disc, Shade(disc, 0.8), 1.4f, cx + 1, b.Top + 9, 21, 21);
            Face(g, cx - 11.5f, cx + 11.5f, b.Top + 19, cx, b.Top + 34, Ink, C(245, 175, 40), 6, "none", false);
            Poly(g, C(240, 170, 60), C(170, 110, 30), 1.2f, P(cx - 4, b.Top + 27), P(cx + 4, b.Top + 27), P(cx, b.Top + 34));
            Bow(g, cx, b.Top + 38, 6);
            Oval(g, C(240, 170, 60), C(170, 110, 30), 1, b.Left + 20, b.Bottom - 4, 9, 5);
            Oval(g, C(240, 170, 60), C(170, 110, 30), 1, b.Left + 35, b.Bottom - 4, 9, 5);
        }

        void Penguin(Graphics g, Rectangle b)
        {
            Color main = C(42, 48, 60), line = C(20, 22, 30), white = C(250, 250, 248), orange = C(245, 160, 50);
            float cx = b.Left + 32, flap = IsWork ? Swing(6, 1.4) * 22 : 0;
            Oval(g, orange, Shade(orange, 0.7), 1.2f, b.Left + 15, b.Bottom - 6, 14, 7);
            Oval(g, orange, Shade(orange, 0.7), 1.2f, b.Left + 35, b.Bottom - 6, 14, 7);
            Turned(g, b.Left + 11, b.Top + 30, 18 + flap, () => Oval(g, main, line, 1.8f, -5, -2, 11, 28));
            Turned(g, b.Right - 11, b.Top + 30, -18 - flap, () => Oval(g, main, line, 1.8f, -6, -2, 11, 28));
            Oval(g, main, line, 2, b.Left + 9, b.Top + 2, 46, 60);
            Oval(g, white, white, 0, b.Left + 16, b.Top + 22, 32, 38);
            Oval(g, white, white, 0, b.Left + 14, b.Top + 10, 17, 18);
            Oval(g, white, white, 0, b.Right - 31, b.Top + 10, 17, 18);
            Face(g, cx - 9.5f, cx + 9.5f, b.Top + 19, cx, b.Top + 33, Ink, Color.Empty, 3.6f, "none", false);
            Poly(g, orange, Shade(orange, 0.7), 1.2f, P(cx - 4.5f, b.Top + 24), P(cx + 4.5f, b.Top + 24), P(cx, b.Top + 30));
            if (Kind == "error" || Kind == "ask") Face(g, -100, -100, -100, cx, b.Top + 34, Ink, Color.Empty, 0, "none", false);
            // a scarf in the status colour
            var a = Accent();
            using (var path = RoundRect(new RectangleF(b.Left + 13, b.Top + 33, 38, 7), 3)) Shape(g, a, Shade(a, 0.7), 1.2f, path);
            using (var path = RoundRect(new RectangleF(b.Right - 22, b.Top + 36, 7, 14), 2.5f)) Shape(g, a, Shade(a, 0.7), 1.2f, path);
            Blush(g, cx - 9, cx + 9, b.Top + 25);
        }

        void Frog(Graphics g, Rectangle b)
        {
            Color main = C(112, 182, 82), line = C(58, 118, 44), belly = C(206, 232, 158);
            float cx = b.Left + 32;
            Oval(g, main, line, 2, b.Left + 3, b.Bottom - 12, 18, 11);
            Oval(g, main, line, 2, b.Right - 21, b.Bottom - 12, 18, 11);
            Oval(g, main, line, 2, b.Left + 2, b.Top + 20, 60, 42);
            Oval(g, belly, belly, 0, b.Left + 14, b.Top + 38, 36, 20);
            Oval(g, main, line, 2, cx - 26, b.Top + 4, 22, 22);
            Oval(g, main, line, 2, cx + 4, b.Top + 4, 22, 22);
            Oval(g, Color.White, Color.White, 0, cx - 22, b.Top + 8, 14, 14);
            Oval(g, Color.White, Color.White, 0, cx + 8, b.Top + 8, 14, 14);
            Face(g, cx - 15, cx + 15, b.Top + 15, cx, b.Top + 37, Ink, Color.Empty, 4, "wide", false);
            // the tongue flicks out now and then while working
            if (IsWork && Tick % 24 < 3)
                using (var pen = Round(C(235, 105, 125), 3)) g.DrawLine(pen, cx, b.Top + 36, cx - 22 - (Tick % 24) * 6, b.Top + 30);
            // a little crown in the status colour: a frog prince
            var a = Accent();
            Poly(g, a, Shade(a, 0.7), 1.2f, P(cx - 7, b.Top + 14), P(cx + 7, b.Top + 14), P(cx + 7, b.Top + 6), P(cx + 3.5f, b.Top + 10), P(cx, b.Top + 4), P(cx - 3.5f, b.Top + 10), P(cx - 7, b.Top + 6));
            Blush(g, cx - 17, cx + 17, b.Top + 28);
        }

        void Axolotl(Graphics g, Rectangle b)
        {
            Color main = C(246, 176, 196), line = C(205, 112, 140), belly = C(252, 222, 230);
            float cx = b.Left + 32, sw = Swing(6, 2);
            Turned(g, b.Right - 12, b.Bottom - 16, -20 + sw * 8, () => Oval(g, main, line, 1.8f, -4, -6, 26, 14));
            Oval(g, main, line, 1.6f, b.Left + 14, b.Bottom - 9, 10, 9);
            Oval(g, main, line, 1.6f, b.Left + 38, b.Bottom - 9, 10, 9);
            Oval(g, main, line, 2, b.Left + 12, b.Top + 34, 40, 28);
            Oval(g, belly, belly, 0, b.Left + 20, b.Top + 42, 24, 16);
            // gill fronds in the status colour, swaying
            var a = Accent();
            for (int i = 0; i < 3; i++)
            {
                float ang = -40 + i * 35 + sw * 6;
                Turned(g, b.Left + 9, b.Top + 22, 180 + ang, () => Oval(g, a, Shade(a, 0.7), 1.2f, 0, -3.5f, 17, 7));
                Turned(g, b.Right - 9, b.Top + 22, -ang, () => Oval(g, a, Shade(a, 0.7), 1.2f, 0, -3.5f, 17, 7));
            }
            Oval(g, main, line, 2, b.Left + 4, b.Top + 8, 56, 36);
            Face(g, cx - 16, cx + 16, b.Top + 23, cx, b.Top + 33, Ink, Color.Empty, 3.4f, "wide", false);
            Blush(g, cx - 16, cx + 16, b.Top + 29);
        }

        void Dragon(Graphics g, Rectangle b)
        {
            Color main = C(108, 178, 128), line = C(52, 112, 70), belly = C(240, 220, 150), horn = C(250, 236, 200);
            float cx = b.Left + 32, sw = Swing(6, 2), flap = IsWork ? Swing(6, 1.6) * 18 : 0;
            Curve(g, line, main, 6, P(b.Right - 14, b.Bottom - 6), P(b.Right + 6, b.Bottom), P(b.Right + 12, b.Top + 40), P(b.Right + 6 + sw * 4, b.Top + 30));
            Poly(g, main, line, 1.6f, P(b.Right + 2 + sw * 4, b.Top + 26), P(b.Right + 12 + sw * 4, b.Top + 30), P(b.Right + 5 + sw * 4, b.Top + 34));
            // wings
            Turned(g, b.Left + 14, b.Top + 34, -20 - flap, () => Poly(g, C(150, 205, 165), line, 1.6f, P(0, 0), P(-14, -18), P(-6, -10), P(-12, -2), P(-4, -2)));
            Turned(g, b.Right - 14, b.Top + 34, 20 + flap, () => Poly(g, C(150, 205, 165), line, 1.6f, P(0, 0), P(14, -18), P(6, -10), P(12, -2), P(4, -2)));
            Oval(g, main, line, 2, b.Left + 11, b.Top + 32, 42, 32);
            Oval(g, belly, belly, 0, cx - 10, b.Top + 38, 20, 24);
            using (var pen = new Pen(Color.FromArgb(120, C(190, 160, 90)), 1.2f))
                for (int i = 0; i < 3; i++) g.DrawLine(pen, cx - 8, b.Top + 44 + i * 6, cx + 8, b.Top + 44 + i * 6);
            Oval(g, main, line, 1.6f, b.Left + 16, b.Bottom - 9, 12, 9);
            Oval(g, main, line, 1.6f, b.Left + 36, b.Bottom - 9, 12, 9);
            Poly(g, horn, Shade(horn, 0.75), 1.4f, P(b.Left + 15, b.Top + 10), P(b.Left + 23, b.Top + 6), P(b.Left + 12, b.Top - 4));
            Poly(g, horn, Shade(horn, 0.75), 1.4f, P(b.Right - 15, b.Top + 10), P(b.Right - 23, b.Top + 6), P(b.Right - 12, b.Top - 4));
            Oval(g, main, line, 2, b.Left + 7, b.Top + 4, 50, 40);
            Oval(g, C(130, 196, 146), C(130, 196, 146), 0, cx - 13, b.Top + 26, 26, 15);
            Oval(g, line, line, 0, cx - 6, b.Top + 29, 3, 2.5f);
            Oval(g, line, line, 0, cx + 3, b.Top + 29, 3, 2.5f);
            Face(g, cx - 11, cx + 11, b.Top + 19, cx, b.Top + 36, Ink, C(245, 200, 60), 4.4f, "smile", true);
            // a puff of smoke on an error, a little flame (the status colour) when done
            if (Kind == "error") Oval(g, Color.FromArgb(150, 160, 160, 165), Color.Empty, 0, cx + 10, b.Top + 22, 10, 8);
            if (Kind == "done")
            {
                var a = Accent();
                Poly(g, a, Shade(a, 0.7), 1, P(cx + 14, b.Top + 34), P(cx + 24, b.Top + 28), P(cx + 21, b.Top + 34), P(cx + 27, b.Top + 36), P(cx + 15, b.Top + 38));
            }
            else
            {
                using (var pen = Round(Accent(), 3f)) g.DrawArc(pen, b.Left + 16, b.Top + 37, 32, 12, 25, 130);
            }
            Blush(g, cx - 11, cx + 11, b.Top + 25);
        }

        void Robot(Graphics g, Rectangle b)
        {
            Color metal = C(186, 196, 212), line = C(108, 118, 140), screen = C(34, 44, 60), glow = C(120, 230, 255);
            float cx = b.Left + 32;
            using (var pen = Round(line, 2.2f)) g.DrawLine(pen, cx, b.Top + 6, cx, b.Top - 6);
            var bulb = IsWork && Tick % 6 < 3 ? Shade(Accent(), 0.6) : Accent();
            Oval(g, bulb, Shade(bulb, 0.7), 1.4f, cx - 4.5f, b.Top - 14, 9, 9);
            using (var path = RoundRect(new RectangleF(b.Left + 14, b.Top + 43, 36, 21), 5)) Shape(g, metal, line, 2, path);
            for (int i = 0; i < 3; i++)
            {
                var lamp = i == 0 ? Accent() : (Tick / 4 + i) % 3 == 0 ? C(120, 220, 140) : C(90, 100, 120);
                Oval(g, lamp, Shade(lamp, 0.7), 1, b.Left + 21 + i * 9, b.Top + 51, 6, 6);
            }
            using (var path = RoundRect(new RectangleF(b.Left + 1, b.Top + 18, 8, 12), 2)) Shape(g, metal, line, 1.6f, path);
            using (var path = RoundRect(new RectangleF(b.Right - 9, b.Top + 18, 8, 12), 2)) Shape(g, metal, line, 1.6f, path);
            using (var path = RoundRect(new RectangleF(b.Left + 6, b.Top + 4, 52, 40), 9)) Shape(g, metal, line, 2, path);
            using (var path = RoundRect(new RectangleF(b.Left + 12, b.Top + 10, 40, 27), 6)) Shape(g, screen, Shade(screen, 0.6), 1.4f, path);
            Face(g, cx - 10, cx + 10, b.Top + 20, cx, b.Top + 31, glow, Color.Empty, 3.6f, "smile", false);
            using (var blush = new SolidBrush(Color.FromArgb(90, 255, 120, 160)))
            {
                g.FillEllipse(blush, cx - 20, b.Top + 26, 7, 4);
                g.FillEllipse(blush, cx + 13, b.Top + 26, 7, 4);
            }
        }

        void Ghost(Graphics g, Rectangle b)
        {
            Color body = Color.FromArgb(238, 250, 250, 255), line = C(180, 186, 212);
            float cx = b.Left + 32, lift = (float)Math.Sin(Tick / 5.0) * 3 - 4, phase = Tick / 3f;
            using (var path = new GraphicsPath())
            {
                float top = b.Top + 2 + lift, bottom = b.Bottom - 6 + lift, left = b.Left + 8, right = b.Right - 8;
                path.AddArc(left, top, right - left, right - left, 180, 180);
                path.AddLine(right, top + (right - left) / 2, right, bottom);
                int waves = 4;
                float step = (right - left) / waves;
                for (int i = 0; i < waves; i++)
                {
                    float x0 = right - i * step, x1 = x0 - step;
                    float dip = (float)Math.Sin(phase + i) * 2;
                    path.AddBezier(x0, bottom, x0 - step / 3, bottom + 7 + dip, x1 + step / 3, bottom + 7 - dip, x1, bottom);
                }
                path.CloseFigure();
                Shape(g, body, line, 2, path);
            }
            float wave = IsWork ? Swing(6, 1.5) * 20 : 0;
            Turned(g, b.Left + 9, b.Top + 34 + lift, 30 + wave, () => Oval(g, body, line, 1.6f, -10, -4, 13, 9));
            Turned(g, b.Right - 9, b.Top + 34 + lift, -30 - wave, () => Oval(g, body, line, 1.6f, -3, -4, 13, 9));
            Face(g, cx - 10, cx + 10, b.Top + 24 + lift, cx, b.Top + 36 + lift, C(50, 50, 70), Color.Empty, 4.4f, "smile", false);
            Blush(g, cx - 10, cx + 10, b.Top + 31 + lift);
        }
    }

    static class Preview
    {
        /// Draws every figure in every state (and the cat in every coat) into one PNG, for a look
        /// without starting the pet: ModBoxPet.exe --preview <file.png>
        public static void Render(string path)
        {
            string[] kinds = { "hello", "work", "done", "ask", "error" };
            int cell = 96, label = 70;
            var rows = new List<string[]>();
            foreach (var pet in Painter.Pets) rows.Add(new[] { pet, "auto" });
            foreach (var fur in Painter.Furs) rows.Add(new[] { "cat", fur });
            foreach (var fur in new[] { "black", "white", "calico", "siamese" }) rows.Add(new[] { "dog", fur });
            foreach (var fur in new[] { "brown", "grey", "calico", "black" }) rows.Add(new[] { "bunny", fur });
            int perCol = (rows.Count + 1) / 2;
            int colW = label + kinds.Length * cell;
            using (var bmp = new Bitmap(colW * 2 + 20, perCol * cell + 30, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(bmp))
            using (var font = new Font("Segoe UI", 8.5f))
            using (var ink = new SolidBrush(Color.FromArgb(70, 70, 80)))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.FromArgb(246, 246, 242));
                for (int col = 0; col < 2; col++)
                    for (int k = 0; k < kinds.Length; k++) g.DrawString(kinds[k], font, ink, col * (colW + 20) + label + k * cell + 30, 4);
                for (int i = 0; i < rows.Count; i++)
                {
                    int col = i / perCol, row = i % perCol;
                    int x0 = col * (colW + 20), y0 = 22 + row * cell;
                    g.DrawString(rows[i][0] + (rows[i][1] == "auto" ? "" : "\n" + rows[i][1]), font, ink, x0 + 4, y0 + 36);
                    for (int k = 0; k < kinds.Length; k++)
                    {
                        var p = new Painter { Pet = rows[i][0], Fur = rows[i][1], Kind = kinds[k], Tick = 7 + k * 3 };
                        p.Paint(g, new Rectangle(x0 + label + k * cell + 16, y0 + 22, 64, 64));
                    }
                }
                bmp.Save(path, ImageFormat.Png);
            }
        }

        /// One pet window's drawing with a question and its choices, for a look at the buttons.
        public static void RenderBubble(string path)
        {
            var w = new PetWindow(path + ".none", 9, 0);
            w.ShowChoices();
            using (var bmp = w.Snapshot())
            {
                bmp.Save(path, ImageFormat.Png);
            }
        }
    }

    static class Native
    {
        public const int WS_EX_LAYERED = 0x80000, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000;
        public const int WM_NCLBUTTONDOWN = 0xA1, HTCAPTION = 2;
        const int ULW_ALPHA = 2;
        const byte AC_SRC_OVER = 0, AC_SRC_ALPHA = 1;

        [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLEND { public byte op, flags, alpha, format; }

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
        [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref POINT pos, ref SIZE size, IntPtr src, ref POINT srcPos, int key, ref BLEND blend, int flags);

        /// Shows the bitmap with its per-pixel alpha as the whole window.
        public static void Apply(Form form, Bitmap bmp)
        {
            IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), hbmp = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hbmp = bmp.GetHbitmap(Color.FromArgb(0));
                old = SelectObject(mem, hbmp);
                var size = new SIZE { cx = bmp.Width, cy = bmp.Height };
                var src = new POINT();
                var pos = new POINT { x = form.Left, y = form.Top };
                var blend = new BLEND { op = AC_SRC_OVER, alpha = 255, format = AC_SRC_ALPHA };
                UpdateLayeredWindow(form.Handle, screen, ref pos, ref size, mem, ref src, 0, ref blend, ULW_ALPHA);
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, screen);
                if (hbmp != IntPtr.Zero) { SelectObject(mem, old); DeleteObject(hbmp); }
                DeleteDC(mem);
            }
        }
    }
}
