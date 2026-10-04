using System.Globalization;
using System.Text;

namespace Hotella.Agent.Fias;

/// <summary>
/// One FIAS record: a two-letter record id and <c>|</c>-separated fields, each a two-character field id and its value
/// (<c>GI|RN504|G#88123|GNNile|DA261003|TI140500|</c>). The agent forwards business records verbatim; it parses only
/// what it needs for the link itself.
/// </summary>
public sealed record FiasRecord(string Id, IReadOnlyList<KeyValuePair<string, string>> Fields)
{
    /// <summary>Link-control records (start, description, record request, alive, end); never forwarded.</summary>
    public static readonly IReadOnlySet<string> LinkRecords = new HashSet<string>(StringComparer.Ordinal)
    {
        "LS", "LD", "LR", "LA", "LE",
    };

    public bool IsLinkRecord => LinkRecords.Contains(Id);

    public string? this[string field] => Fields.FirstOrDefault(f => f.Key == field).Value;

    public static FiasRecord Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var parts = text.Split('|');
        var id = parts[0];
        if (id.Length != 2 || !id.All(char.IsAsciiLetterUpper))
            throw new FormatException("record id must be two upper-case letters");
        var fields = new List<KeyValuePair<string, string>>();
        foreach (var part in parts.Skip(1))
        {
            if (part.Length == 0) continue;
            if (part.Length < 2) throw new FormatException("malformed field");
            fields.Add(new(part[..2], part[2..]));
        }
        return new FiasRecord(id, fields);
    }

    /// <summary>A record stamped with the hotel's local date and time (DA/TI), as FIAS expects.</summary>
    public static FiasRecord Create(string id, DateTime local, params (string field, string value)[] fields)
    {
        var all = fields.Select(f => new KeyValuePair<string, string>(f.field, f.value)).ToList();
        all.Add(new("DA", local.ToString("yyMMdd", CultureInfo.InvariantCulture)));
        all.Add(new("TI", local.ToString("HHmmss", CultureInfo.InvariantCulture)));
        return new FiasRecord(id, all);
    }

    public override string ToString()
    {
        var text = new StringBuilder(Id).Append('|');
        foreach (var (key, value) in Fields) text.Append(key).Append(value).Append('|');
        return text.ToString();
    }
}

/// <summary>FIAS framing on the TCP stream: STX (0x02) record ETX (0x03); bytes outside a frame are line noise.</summary>
public static class FiasFraming
{
    public const byte Stx = 0x02;
    public const byte Etx = 0x03;
    public const int MaxRecordBytes = 8 * 1024;

    public static byte[] Frame(string record, Encoding encoding)
    {
        ArgumentNullException.ThrowIfNull(encoding);
        var body = encoding.GetBytes(record);
        var frame = new byte[body.Length + 2];
        frame[0] = Stx;
        body.CopyTo(frame, 1);
        frame[^1] = Etx;
        return frame;
    }

    /// <summary>Reads records until the stream ends; a frame longer than the limit is dropped, not buffered forever.</summary>
    public static async IAsyncEnumerable<string> ReadAsync(
        Stream stream, Encoding encoding, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(stream);
        ArgumentNullException.ThrowIfNull(encoding);
        var buffer = new byte[4096];
        using var record = new MemoryStream();
        var inFrame = false;
        var oversized = false;
        int read;
        while ((read = await stream.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            for (var i = 0; i < read; i++)
            {
                var b = buffer[i];
                if (b == Stx)
                {
                    inFrame = true;
                    oversized = false;
                    record.SetLength(0);
                }
                else if (b == Etx && inFrame)
                {
                    inFrame = false;
                    if (!oversized) yield return encoding.GetString(record.GetBuffer(), 0, (int)record.Length);
                }
                else if (inFrame && !oversized)
                {
                    if (record.Length >= MaxRecordBytes) oversized = true;
                    else record.WriteByte(b);
                }
            }
        }
    }
}
