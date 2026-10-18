using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

namespace ClipRelay.Remote {
    internal static class ServiceProcessAccess {
        // The desktop publisher holds a live service handle while checking the
        // named-pipe server PID. Ordinary desktop tokens need these read-only
        // rights; making the whole desktop application elevated breaks capture.
        internal const int QueryAndSynchronize = 0x00101000;
        const uint DaclSecurityInformation = 4;

        internal static void AllowOperatorReadHandle(string operatorSid) {
            var sid = new SecurityIdentifier(operatorSid);
            if (!sid.IsAccountSid()) throw new ArgumentException("Operator must be an account SID.");
            IntPtr process = GetCurrentProcess();
            uint needed;
            GetKernelObjectSecurity(process, DaclSecurityInformation, null, 0, out needed);
            if (needed == 0 || needed > 1024 * 1024) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] original = new byte[needed];
            if (!GetKernelObjectSecurity(process, DaclSecurityInformation, original, needed, out needed))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var descriptor = new RawSecurityDescriptor(original, 0);
            var acl = descriptor.DiscretionaryAcl;
            if (acl == null) throw new InvalidOperationException("Service process must have a DACL.");
            // Preserve every existing ACE and insert before inherited entries.
            // No memory access, termination, token access, or DACL writes are granted.
            int index = 0;
            while (index < acl.Count && (acl[index].AceFlags & AceFlags.Inherited) == 0) index++;
            acl.InsertAce(index, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed,
                QueryAndSynchronize, sid, false, null));
            byte[] updated = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(updated, 0);
            if (!SetKernelObjectSecurity(process, DaclSecurityInformation, updated))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }

        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetKernelObjectSecurity(
            IntPtr handle, uint information, byte[] descriptor, uint length, out uint needed);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetKernelObjectSecurity(
            IntPtr handle, uint information, byte[] descriptor);
    }
}
