using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using WixToolset.Dtf.WindowsInstaller;

namespace Hotella.Agent.Installer
{
    /// <summary>
    /// The enrollment codes typed in the installer reach <c>hotella-agent setup install</c> through a file in the data
    /// directory, made SYSTEM/Administrators-only first. Never a command line; the action and its data are hidden, so
    /// the codes are not in the MSI log either. The agent deletes the file once read.
    /// </summary>
    public static class CustomActions
    {
        public const string CodesFileName = "enroll.codes";

        [CustomAction]
        public static ActionResult WriteEnrollmentCodes(Session session)
        {
            var data = session.CustomActionData;
            var codes = new List<string>();
            foreach (var key in new[] { "Code1", "Code2", "Code3" })
            {
                if (data.TryGetValue(key, out var code) && !string.IsNullOrWhiteSpace(code)) codes.Add(code.Trim());
            }
            if (codes.Count == 0) return ActionResult.Success;

            var folder = data["Folder"];
            Directory.CreateDirectory(folder);
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            foreach (var sid in new[] { WellKnownSidType.LocalSystemSid, WellKnownSidType.BuiltinAdministratorsSid })
            {
                security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid, null),
                    FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None, AccessControlType.Allow));
            }
            new DirectoryInfo(folder).SetAccessControl(security);
            File.WriteAllText(Path.Combine(folder, CodesFileName), string.Join("\r\n", codes) + "\r\n",
                new UTF8Encoding(false));
            session.Log("Hotella: " + codes.Count + " enrollment code(s) handed to setup");
            return ActionResult.Success;
        }
    }
}
