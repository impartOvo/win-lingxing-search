using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace ProductDiagnosis
{
    internal static class AutomationRunner
    {
        internal static int Run(string root, string[] args)
        {
            string dataRoot = root;
            try
            {
                if (args.Length == 3 && args[1] == "--data") dataRoot = Path.GetFullPath(args[2]);
                else if (args.Length != 1) throw new ArgumentException("无效的定时运行参数。");

                var info = NativeWindow.NodeStartInfo(root, new[] {
                    Path.Combine(root, "automation", "cli.cjs"), "tick", "--data", dataRoot
                });
                info.RedirectStandardInput = true;
                info.EnvironmentVariables["LINGXING_DATA_DIR"] = dataRoot;
                using (var process = new Process { StartInfo = info })
                {
                    process.Start();
                    process.StandardInput.Close();
                    var output = process.StandardOutput.ReadToEndAsync();
                    var error = process.StandardError.ReadToEndAsync();
                    process.WaitForExit();
                    Task.WaitAll(output, error);
                    // cli.cjs records scheduler failures; preserve its exit status for Task Scheduler.
                    return process.ExitCode;
                }
            }
            catch (Exception error)
            {
                try
                {
                    string log = Path.Combine(dataRoot, ".private", "automation", "logs", "scheduler-error.log");
                    Directory.CreateDirectory(Path.GetDirectoryName(log));
                    File.AppendAllText(log, DateTimeOffset.Now.ToString("o") + " " + error.Message + Environment.NewLine, new UTF8Encoding(false));
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                // Background launch failures must not display a MessageBox or open the main window.
                return 1;
            }
        }
    }
}
