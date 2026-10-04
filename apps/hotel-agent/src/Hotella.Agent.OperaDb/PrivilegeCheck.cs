namespace Hotella.Agent.OperaDb;

/// <summary>
/// The read-only self-check (guide §6.4 rule 3): the account may hold <c>CREATE SESSION</c> and <c>SELECT</c> (or
/// <c>READ</c>) on the contract objects of the OPERA owner — and nothing else: no other system privilege, no role, no
/// write or <c>ANY</c> privilege, no grant on another object. Any finding refuses every query until it is fixed.
/// </summary>
public static class PrivilegeCheck
{
    public static IReadOnlyList<string> Problems(PrivilegeSnapshot snapshot, string owner)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var problems = new List<string>();
        var system = snapshot.SystemPrivileges.Select(p => p.Trim().ToUpperInvariant()).ToHashSet(StringComparer.Ordinal);
        if (!system.Contains("CREATE SESSION")) problems.Add("missing CREATE SESSION");
        foreach (var p in system.Where(p => p != "CREATE SESSION").Order(StringComparer.Ordinal))
            problems.Add($"system privilege {p} is not allowed");
        foreach (var r in snapshot.Roles.Select(r => r.Trim().ToUpperInvariant()).Order(StringComparer.Ordinal))
            problems.Add($"role {r} is not allowed");
        foreach (var (o, t, p) in snapshot.TablePrivileges)
        {
            var privilege = p.Trim().ToUpperInvariant();
            var obj = $"{o.Trim().ToUpperInvariant()}.{t.Trim().ToUpperInvariant()}";
            var contract = string.Equals(o.Trim(), owner, StringComparison.OrdinalIgnoreCase)
                && DataContract.Objects.Contains(t.Trim().ToUpperInvariant());
            if (privilege is not ("SELECT" or "READ")) problems.Add($"{privilege} on {obj} is not allowed");
            else if (!contract) problems.Add($"{privilege} on {obj} is outside the data contract");
        }
        return problems;
    }
}
