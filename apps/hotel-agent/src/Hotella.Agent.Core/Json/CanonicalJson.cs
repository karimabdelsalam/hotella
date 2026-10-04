using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hotella.Agent.Core.Json;

/// <summary>
/// Deterministic JSON — sorted keys, no whitespace — producing exactly the bytes of the platform's
/// <c>canonicalJson</c> (packages/platform/pki): strings escaped like ECMAScript <c>JSON.stringify</c>, numbers written
/// like ECMAScript <c>Number.prototype.toString</c>, keys ordered by UTF-16 code unit. Command signatures cover these
/// bytes (ADR-0017 §5), so any difference would reject a genuine command; the shared vector test pins them.
/// </summary>
public static class CanonicalJson
{
    public static string Serialize(JsonNode? node)
    {
        var sb = new StringBuilder();
        Write(sb, node);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, JsonNode? node)
    {
        switch (node)
        {
            case null:
                sb.Append("null");
                return;
            case JsonObject obj:
                sb.Append('{');
                var first = true;
                foreach (var (key, value) in obj.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, key);
                    sb.Append(':');
                    Write(sb, value);
                }
                sb.Append('}');
                return;
            case JsonArray array:
                sb.Append('[');
                for (var i = 0; i < array.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    Write(sb, array[i]);
                }
                sb.Append(']');
                return;
            case JsonValue value:
                WriteValue(sb, value);
                return;
        }
    }

    private static void WriteValue(StringBuilder sb, JsonValue value)
    {
        if (!value.TryGetValue<JsonElement>(out var element))
        {
            // A value built in code rather than parsed: normalise it through its JSON form.
            element = JsonDocument.Parse(value.ToJsonString()).RootElement.Clone();
        }
        switch (element.ValueKind)
        {
            case JsonValueKind.String:
                WriteString(sb, element.GetString()!);
                return;
            case JsonValueKind.Number:
                sb.Append(FormatNumber(element.GetDouble()));
                return;
            case JsonValueKind.True:
                sb.Append("true");
                return;
            case JsonValueKind.False:
                sb.Append("false");
                return;
            default:
                sb.Append("null");
                return;
        }
    }

    /// <summary>ECMAScript JSON.stringify string quoting.</summary>
    internal static void WriteString(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        sb.Append(c).Append(s[i + 1]);
                        i++;
                    }
                    else if (char.IsSurrogate(c))
                        // A lone surrogate is escaped (well-formed JSON.stringify, ES2019).
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    /// <summary>ECMAScript Number::toString for finite doubles (shortest round-trip digits).</summary>
    internal static string FormatNumber(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
        if (d == 0) return "0";
        var negative = d < 0;
        // "R" gives the shortest round-trip digits (as ECMAScript does); only the layout differs.
        var (digits, n) = Decompose(Math.Abs(d).ToString("R", CultureInfo.InvariantCulture));
        var k = digits.Length;
        string body;
        if (k <= n && n <= 21) body = digits + new string('0', n - k);
        else if (0 < n && n <= 21) body = digits[..n] + "." + digits[n..];
        else if (-6 < n && n <= 0) body = "0." + new string('0', -n) + digits;
        else
        {
            var e = n - 1;
            var exp = (e >= 0 ? "+" : "-") + Math.Abs(e).ToString(CultureInfo.InvariantCulture);
            body = k == 1 ? digits + "e" + exp : digits[..1] + "." + digits[1..] + "e" + exp;
        }
        return negative ? "-" + body : body;
    }

    /// <summary>Splits a .NET round-trip string into significant digits and the ECMAScript exponent n.</summary>
    private static (string digits, int n) Decompose(string s)
    {
        var exponent = 0;
        var e = s.IndexOfAny(['E', 'e']);
        if (e >= 0)
        {
            exponent = int.Parse(s[(e + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            s = s[..e];
        }
        var dot = s.IndexOf('.', StringComparison.Ordinal);
        var intPart = dot >= 0 ? s[..dot] : s;
        var fracPart = dot >= 0 ? s[(dot + 1)..] : "";
        var all = (intPart + fracPart).TrimStart('0');
        var leadingZeros = (intPart + fracPart).Length - all.Length;
        var n = intPart.Length - leadingZeros + exponent;
        all = all.TrimEnd('0');
        return (all.Length == 0 ? "0" : all, n);
    }
}
