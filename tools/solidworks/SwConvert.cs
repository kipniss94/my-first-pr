// SOLIDWORKS bridge for DocuView.
//
// This is the only piece of DocuView that talks to SOLIDWORKS. It opens a part
// or assembly exactly as it was saved and writes it out as STEP; everything
// after that - OpenCascade, the mesh, the browser - is DocuView's own. The
// person looking at the model needs no CAD; SOLIDWORKS runs hidden on the
// machine that serves the viewer.
//
// It is compiled on the user's PC by the C# compiler that ships with Windows
// (.NET Framework 4.x, csc.exe), so there is nothing to download and no script
// execution policy involved. That compiler only understands C# 5, so this file
// avoids everything newer: no string interpolation, no ?. and no nameof.
//
//   sw-convert.exe convert <source.sldprt> <output.step> <part|assembly>
//   sw-convert.exe warmup  <marker-file> [api-port]   start SOLIDWORKS hidden
//   sw-convert.exe quit    <marker-file>              close the one we started
//
// Exit codes: 0 done, 1 failed, 2 bad arguments, 4 SOLIDWORKS busy too long.

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

public class ConversionException : Exception
{
    public int Code;
    public ConversionException(int code, string message) : base(message) { Code = code; }
}

public static class SwConvert
{
    // Values from the SOLIDWORKS API help (swconst).
    const int swDocPART = 1;
    const int swDocASSEMBLY = 2;
    const int swOpenDocOptions_Silent = 1;
    const int swOpenDocOptions_ReadOnly = 2;
    const int swOpenDocOptions_OverrideDefaultLoadLightweight = 64;
    const int swSaveAsCurrentVersion = 0;
    const int swSaveAsOptions_Silent = 1;
    const int swSaveAsOptions_Copy = 2;

    // One conversion at a time: every caller drives the same SOLIDWORKS session.
    const string MutexName = @"Local\DocuViewSolidWorks";

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length >= 4 && args[0] == "convert")
            {
                return RunConvert(args[1], args[2], args[3], 540);
            }
            if (args.Length >= 2 && args[0] == "warmup")
            {
                int port = 0;
                if (args.Length >= 3) int.TryParse(args[2], out port);
                return RunWarmup(args[1], port);
            }
            if (args.Length >= 2 && args[0] == "quit")
            {
                return RunQuit(args[1]);
            }
            Console.Error.WriteLine("usage: sw-convert convert <source> <output.step> <part|assembly> | warmup <marker> [port] | quit <marker>");
            return 2;
        }
        catch (ConversionException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return ex.Code;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(Describe(ex));
            return 1;
        }
    }

    // ------------------------------------------------------------ convert --

    static int RunConvert(string source, string output, string kind, int timeoutSeconds)
    {
        int docType = kind == "assembly" ? swDocASSEMBLY : swDocPART;
        using (Mutex mutex = new Mutex(false, MutexName))
        {
            bool locked = false;
            try
            {
                try { locked = mutex.WaitOne(TimeSpan.FromSeconds(timeoutSeconds)); }
                catch (AbandonedMutexException) { locked = true; }
                if (!locked) throw new ConversionException(4, "SOLIDWORKS stayed busy with other conversions for too long.");

                object sw = GetSolidWorks();
                try
                {
                    SetQuietly(sw, "CommandInProgress", true);
                    ConvertWith(sw, source, output, docType, Log);
                }
                finally
                {
                    SetQuietly(sw, "CommandInProgress", false);
                    Release(sw);
                }
            }
            finally
            {
                if (locked) mutex.ReleaseMutex();
            }
        }
        return 0;
    }

    /// <summary>
    /// Open, export, close. Separate from the COM plumbing so it can be
    /// exercised with a stand-in object on a machine without SOLIDWORKS.
    /// </summary>
    public static void ConvertWith(dynamic sw, string source, string output, int docType, Action<string> log)
    {
        int errors = 0;
        int warnings = 0;
        int options = swOpenDocOptions_Silent | swOpenDocOptions_ReadOnly;
        if (docType == swDocASSEMBLY) options |= swOpenDocOptions_OverrideDefaultLoadLightweight;

        dynamic doc = null;
        try
        {
            doc = sw.OpenDoc6(source, docType, options, "", ref errors, ref warnings);
        }
        catch (Exception ex)
        {
            log("OpenDoc6 failed (" + ex.Message + "), falling back to OpenDoc");
            doc = sw.OpenDoc(source, docType);
        }
        if (doc == null)
        {
            throw new ConversionException(1, "SOLIDWORKS could not open the file (load error " + errors + ")." + ExplainLoadError(errors));
        }

        try
        {
            int saveErrors = 0;
            int saveWarnings = 0;
            bool saved = false;
            int saveOptions = swSaveAsOptions_Silent | swSaveAsOptions_Copy;
            try
            {
                saved = (bool)doc.Extension.SaveAs(output, swSaveAsCurrentVersion, saveOptions, null, ref saveErrors, ref saveWarnings);
            }
            catch (Exception ex)
            {
                log("Extension.SaveAs failed (" + ex.Message + "), falling back to SaveAs3");
            }
            if (!saved || !File.Exists(output))
            {
                int code = (int)doc.SaveAs3(output, swSaveAsCurrentVersion, saveOptions);
                if (code != 0) log("SaveAs3 returned " + code);
            }
            if (!File.Exists(output) || new FileInfo(output).Length == 0)
            {
                throw new ConversionException(1, "SOLIDWORKS opened the model but wrote no STEP (save error " + saveErrors + ").");
            }
        }
        finally
        {
            string title = null;
            try { title = (string)doc.GetTitle(); } catch { }
            if (title != null)
            {
                try { sw.QuitDoc(title); }
                catch { try { sw.CloseDoc(title); } catch { } }
            }
            Release(doc);
        }
    }

    static string ExplainLoadError(int errors)
    {
        // swFileLoadError_e. Only the ones a person can act on are spelled out.
        if ((errors & 8192) != 0) return " It was saved by a newer SOLIDWORKS than the one installed here.";
        if ((errors & 2) != 0) return " SOLIDWORKS could not find the file.";
        if ((errors & 1024) != 0) return " It is not a SOLIDWORKS document.";
        if ((errors & 2097152) != 0 || (errors & 4194304) != 0) return " The file is damaged and needs repair in SOLIDWORKS.";
        return "";
    }

    // ------------------------------------------------------- warmup / quit --

    static int RunWarmup(string marker, int apiPort)
    {
        object sw;
        // Hold the conversion lock while SOLIDWORKS starts, so a model dropped
        // into the browser during those 20-60 seconds waits for this instance
        // rather than racing it into starting a second one.
        using (Mutex mutex = new Mutex(false, MutexName))
        {
            bool locked = false;
            try { locked = mutex.WaitOne(TimeSpan.FromSeconds(120)); }
            catch (AbandonedMutexException) { locked = true; }
            try
            {
                bool wasRunning = Process.GetProcessesByName("SLDWORKS").Length > 0;
                sw = GetSolidWorks();
                if (!wasRunning)
                {
                    // Ours: keep it out of sight and remember it, so quit may
                    // close it. A SOLIDWORKS the user opened is never hidden or closed.
                    SetQuietly(sw, "Visible", false);
                    Process[] running = Process.GetProcessesByName("SLDWORKS");
                    if (running.Length > 0) File.WriteAllText(marker, running[0].Id.ToString());
                }
                string revision = "";
                try { revision = (string)((dynamic)sw).RevisionNumber(); } catch { }
                Log("SOLIDWORKS ready, revision " + revision + (wasRunning ? " (attached to a running session)" : " (started in the background)"));
            }
            finally
            {
                if (locked) mutex.ReleaseMutex();
            }
        }

        if (apiPort > 0)
        {
            // A COM-started SOLIDWORKS lives as long as someone holds it. Hold it
            // while the viewer's API answers; a minute after it stops, let go and
            // close what we started.
            int missing = 0;
            while (missing < 6)
            {
                Thread.Sleep(10000);
                missing = PortOpen(apiPort) ? 0 : missing + 1;
            }
            Release(sw);
            return RunQuit(marker);
        }
        Release(sw);
        return 0;
    }

    static int RunQuit(string marker)
    {
        if (!File.Exists(marker)) return 0;
        int pid;
        int.TryParse(File.ReadAllText(marker).Trim(), out pid);
        File.Delete(marker);
        Process own = null;
        foreach (Process p in Process.GetProcessesByName("SLDWORKS")) if (p.Id == pid) own = p;
        if (own == null) return 0;
        try
        {
            dynamic sw = GetSolidWorks();
            sw.ExitApp();
            Release(sw);
        }
        catch { }
        if (!own.WaitForExit(15000))
        {
            try { own.Kill(); } catch { }
        }
        Log("background SOLIDWORKS closed");
        return 0;
    }

    // ------------------------------------------------------------ plumbing --

    static object GetSolidWorks()
    {
        // Attach first: a cold start of SOLIDWORKS costs 20-60 seconds.
        // Looked up by reflection because it exists only on .NET Framework,
        // which is what compiles this on Windows; the tests build it elsewhere.
        System.Reflection.MethodInfo getActive = typeof(Marshal).GetMethod("GetActiveObject", new Type[] { typeof(string) });
        if (getActive != null)
        {
            try { return getActive.Invoke(null, new object[] { "SldWorks.Application" }); } catch { }
        }
        string last = null;
        foreach (string progId in new string[] { "SldWorks.Application", "SldWorks.Application.32", "SldWorks.Application.31" })
        {
            Type type = Type.GetTypeFromProgID(progId, false);
            if (type == null) continue;
            try { return Activator.CreateInstance(type); }
            catch (Exception ex) { last = ex.Message; }
        }
        throw new ConversionException(1, "SOLIDWORKS could not be started. Is it installed and licensed for this Windows user?" + (last == null ? "" : " " + last));
    }

    static void SetQuietly(object target, string property, bool value)
    {
        try { target.GetType().InvokeMember(property, System.Reflection.BindingFlags.SetProperty, null, target, new object[] { value }); }
        catch { }
    }

    static bool PortOpen(int port)
    {
        try
        {
            using (TcpClient client = new TcpClient())
            {
                IAsyncResult wait = client.BeginConnect("127.0.0.1", port, null, null);
                if (!wait.AsyncWaitHandle.WaitOne(1000)) return false;
                client.EndConnect(wait);
                return true;
            }
        }
        catch { return false; }
    }

    static void Release(object com)
    {
        if (com == null || !Marshal.IsComObject(com)) return;
        try { Marshal.ReleaseComObject(com); } catch { }
    }

    static string Describe(Exception ex)
    {
        COMException com = ex as COMException;
        return com != null ? "SOLIDWORKS reported an error (0x" + com.ErrorCode.ToString("X8") + "): " + com.Message : ex.Message;
    }

    static void Log(string message)
    {
        Console.Out.WriteLine(message);
    }
}
