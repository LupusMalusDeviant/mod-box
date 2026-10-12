// Mod Box Pet: a small always-on-top desktop companion that shows what Claude Code is doing in a
// speech bubble. It only reads a status file the pet mod writes (key=value lines) and draws:
// no network, no input to Claude. Drag it anywhere; right-click for its menu.
//
//   ModBoxPet.exe <status file> [bubble seconds]
//
// One pet per user (a named mutex); a second start exits at once.
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
            bool isFirst;
            using (var mutex = new Mutex(true, "Local\\ModBoxPet", out isFirst))
            {
                if (!isFirst) return 0;
                Native.SetProcessDPIAware();
                Application.EnableVisualStyles();
                int seconds = 9;
                if (args.Length > 1) int.TryParse(args[1], out seconds);
                Application.Run(new PetWindow(args[0], Math.Max(3, Math.Min(60, seconds))));
            }
            return 0;
        }
    }

    sealed class Status
    {
        public long At;
        public string Kind = "idle";
        public string Title = "";
        public string Text = "";

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
            }
            return s;
        }
    }

    sealed class PetWindow : Form
    {
        const int W = 340, H = 250, BODY = 64;
        readonly string statusPath;
        readonly int bubbleMs;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly string posPath;
        DateTime lastWrite = DateTime.MinValue;
        DateTime shownAt = DateTime.MinValue;
        DateTime lastNews = DateTime.Now;
        DateTime byeAt = DateTime.MaxValue;
        DateTime snoozeUntil = DateTime.MinValue;
        Status status = new Status { Kind = "hello", Text = "Hallo! Ich passe auf." };
        int tick;
        bool isBubble = true;
        Rectangle bubbleRect = Rectangle.Empty;

        public PetWindow(string statusPath, int bubbleSeconds)
        {
            this.statusPath = statusPath;
            bubbleMs = bubbleSeconds * 1000;
            posPath = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath) ?? ".", "position.txt");
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
            return new Point(area.Right - W - 24, area.Bottom - H - 8);
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
            bool isSticky = status.Kind == "ask" || status.Kind == "error";
            if (isBubble && !isSticky && status.Kind != "work" && (DateTime.Now - shownAt).TotalMilliseconds > bubbleMs) isBubble = false;
            if (isBubble && status.Kind == "work" && (DateTime.Now - shownAt).TotalMilliseconds > bubbleMs * 4) isBubble = false;
            Draw();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            if (isBubble && bubbleRect.Contains(e.Location) && e.Clicks == 2) { isBubble = false; Draw(); return; }
            Native.ReleaseCapture();
            Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, (IntPtr)Native.HTCAPTION, IntPtr.Zero);
            SavePosition();
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            // a click on the pet itself brings the last message back
            if (e.Button == MouseButtons.Left && !isBubble && e.Y > H - BODY - 30) { isBubble = true; shownAt = DateTime.Now; Draw(); }
        }

        Color Accent()
        {
            switch (status.Kind)
            {
                case "error": return Color.FromArgb(230, 90, 80);
                case "done": return Color.FromArgb(80, 190, 120);
                case "ask": return Color.FromArgb(240, 180, 60);
                case "work": return Color.FromArgb(90, 150, 240);
                default: return Color.FromArgb(215, 120, 80);
            }
        }

        void Draw()
        {
            if (!IsHandleCreated) return;
            using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    g.Clear(Color.Transparent);
                    int bob = (int)Math.Round(Math.Sin(tick / 6.0) * (status.Kind == "work" ? 3 : 1.5));
                    var body = new Rectangle(W - BODY - 18, H - BODY - 10 + bob, BODY, BODY);
                    if (isBubble) DrawBubble(g, body);
                    else bubbleRect = Rectangle.Empty;
                    DrawPet(g, body);
                }
                Native.Apply(this, bmp);
            }
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
                int bw = (int)Math.Min(maxW, Math.Max(textSize.Width, titleSize.Width) + 26);
                int bh = (int)Math.Min(H - BODY - 40, textSize.Height + titleSize.Height + 20);
                var r = new Rectangle(W - bw - 8, body.Top - bh - 18, bw, bh);
                bubbleRect = r;
                using (var path = Rounded(r, 12))
                {
                    // tail towards the pet
                    var tail = new[] { new Point(body.Left + 20, r.Bottom - 1), new Point(body.Left + 36, r.Bottom - 1), new Point(body.Left + 26, body.Top - 4) };
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
                    g.DrawString(text, font, b, new RectangleF(r.Left + 12, y, r.Width - 22, r.Bottom - y - 6), new StringFormat { Trimming = StringTrimming.EllipsisWord });
            }
        }

        void DrawPet(Graphics g, Rectangle b)
        {
            // The Mod Box itself: a little cardboard box with a face.
            var accent = Accent();
            using (var shadow = new SolidBrush(Color.FromArgb(60, 0, 0, 0))) g.FillEllipse(shadow, b.Left + 6, b.Bottom - 4, b.Width - 12, 10);
            using (var path = Rounded(new Rectangle(b.Left, b.Top + 10, b.Width, b.Height - 10), 10))
            using (var fill = new LinearGradientBrush(b, Color.FromArgb(236, 196, 140), Color.FromArgb(205, 155, 95), 90f))
            using (var pen = new Pen(Color.FromArgb(150, 100, 55), 2f))
            {
                g.FillPath(fill, path);
                g.DrawPath(pen, path);
            }
            // lid flaps, a little open while working
            int open = status.Kind == "work" ? (int)(Math.Abs(Math.Sin(tick / 3.0)) * 6) : 0;
            using (var lid = new SolidBrush(Color.FromArgb(222, 175, 115)))
            using (var pen = new Pen(Color.FromArgb(150, 100, 55), 2f))
            {
                var left = new[] { new Point(b.Left - 2, b.Top + 12), new Point(b.Left + b.Width / 2, b.Top + 12), new Point(b.Left + b.Width / 2 - 4, b.Top + 2 - open), new Point(b.Left + 4, b.Top + 4 - open) };
                var right = new[] { new Point(b.Right + 2, b.Top + 12), new Point(b.Left + b.Width / 2, b.Top + 12), new Point(b.Left + b.Width / 2 + 4, b.Top + 2 - open), new Point(b.Right - 4, b.Top + 4 - open) };
                g.FillPolygon(lid, left); g.DrawPolygon(pen, left);
                g.FillPolygon(lid, right); g.DrawPolygon(pen, right);
            }
            // a strip of tape in the status colour
            using (var tape = new SolidBrush(Color.FromArgb(200, accent))) g.FillRectangle(tape, b.Left + b.Width / 2 - 5, b.Top + 12, 10, 12);

            int ey = b.Top + 34, lx = b.Left + 20, rx = b.Right - 20;
            bool isBlink = tick % 40 == 0 || tick % 40 == 1;
            using (var ink = new Pen(Color.FromArgb(60, 40, 30), 2.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
            using (var dot = new SolidBrush(Color.FromArgb(60, 40, 30)))
            {
                if (status.Kind == "done")
                {
                    g.DrawArc(ink, lx - 5, ey - 2, 10, 8, 200, 140);
                    g.DrawArc(ink, rx - 5, ey - 2, 10, 8, 200, 140);
                }
                else if (isBlink)
                {
                    g.DrawLine(ink, lx - 4, ey + 1, lx + 4, ey + 1);
                    g.DrawLine(ink, rx - 4, ey + 1, rx + 4, ey + 1);
                }
                else
                {
                    int look = status.Kind == "work" ? (int)Math.Round(Math.Sin(tick / 8.0) * 2) : 0;
                    g.FillEllipse(dot, lx - 4 + look, ey - 4, 8, 9);
                    g.FillEllipse(dot, rx - 4 + look, ey - 4, 8, 9);
                    using (var shine = new SolidBrush(Color.White))
                    {
                        g.FillEllipse(shine, lx - 2 + look, ey - 3, 3, 3);
                        g.FillEllipse(shine, rx - 2 + look, ey - 3, 3, 3);
                    }
                }
                int my = b.Top + 48, mx = b.Left + b.Width / 2;
                if (status.Kind == "error") g.DrawArc(ink, mx - 7, my, 14, 8, 200, 140);
                else if (status.Kind == "ask") g.DrawEllipse(ink, mx - 3, my - 1, 6, 7);
                else g.DrawArc(ink, mx - 7, my - 6, 14, 10, 20, 140);
            }
            using (var blush = new SolidBrush(Color.FromArgb(70, 230, 110, 110)))
            {
                g.FillEllipse(blush, lx - 10, ey + 8, 9, 5);
                g.FillEllipse(blush, rx + 1, ey + 8, 9, 5);
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
