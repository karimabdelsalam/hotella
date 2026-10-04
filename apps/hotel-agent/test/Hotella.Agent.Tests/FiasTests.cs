using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Hotella.Agent.Core.Link;
using Hotella.Agent.Core.Queue;
using Hotella.Agent.Fias;
using Microsoft.Extensions.Logging.Abstractions;

namespace Hotella.Agent.Tests;

public class FiasTests
{
    private static readonly Encoding Utf8 = Encoding.UTF8;

    [Fact]
    public async Task Frames_are_read_across_packets_and_noise_between_frames_is_ignored()
    {
        var bytes = new List<byte> { (byte)'x', 0x0A };
        bytes.AddRange(FiasFraming.Frame("LS|DA261004|TI120000|", Utf8));
        bytes.AddRange(Utf8.GetBytes("noise"));
        bytes.AddRange(FiasFraming.Frame("GI|RN504|GNنيل|", Utf8));
        var oversized = new byte[FiasFraming.MaxRecordBytes + 10];
        Array.Fill(oversized, (byte)'A');
        bytes.Add(FiasFraming.Stx);
        bytes.AddRange(oversized);
        bytes.Add(FiasFraming.Etx);
        bytes.AddRange(FiasFraming.Frame("GO|RN504|", Utf8));
        using var stream = new TrickleStream(bytes.ToArray(), chunk: 3);
        var records = new List<string>();
        await foreach (var r in FiasFraming.ReadAsync(stream, Utf8, CancellationToken.None)) records.Add(r);
        Assert.Equal(["LS|DA261004|TI120000|", "GI|RN504|GNنيل|", "GO|RN504|"], records);
    }

    [Fact]
    public void Records_parse_and_format_with_hotel_date_and_time()
    {
        var gi = FiasRecord.Parse("GI|RN504|G#88123|GNNile|SF|");
        Assert.Equal("GI", gi.Id);
        Assert.Equal("504", gi["RN"]);
        Assert.Equal("", gi["SF"]);
        Assert.False(gi.IsLinkRecord);
        Assert.True(FiasRecord.Parse("LA|").IsLinkRecord);
        Assert.Throws<FormatException>(() => FiasRecord.Parse("gi|RN504|"));
        var re = FiasRecord.Create("RE", new DateTime(2026, 10, 4, 7, 5, 9), ("RN", "504"), ("RS", "3"));
        Assert.Equal("RE|RN504|RS3|DA261004|TI070509|", re.ToString());
    }

    [Theory]
    [InlineData("DIRTY", false, "1")]
    [InlineData("DIRTY", true, "2")]
    [InlineData("CLEAN", false, "3")]
    [InlineData("CLEAN", true, "4")]
    [InlineData("INSPECTED", false, "5")]
    [InlineData("INSPECTED", true, "6")]
    [InlineData("OOO", false, null)]
    public void Room_status_codes_carry_occupancy(string status, bool occupied, string? code) =>
        Assert.Equal(code, FiasAdapter.RoomStatusCode(status, occupied));

    [Fact]
    public void A_record_repeated_by_IFC8_keeps_its_message_id_per_instance()
    {
        using var a = new FiasAdapter(new FiasSettings(), "instance-a", NullLogger.Instance);
        using var b = new FiasAdapter(new FiasSettings(), "instance-b", NullLogger.Instance);
        const string record = "GI|RN504|G#1|DA261004|TI120000|";
        Assert.Equal(a.SourceMessageId(record), a.SourceMessageId(record));
        Assert.NotEqual(a.SourceMessageId(record), b.SourceMessageId(record));
        Assert.NotEqual(a.SourceMessageId(record), a.SourceMessageId(record.Replace("504", "505", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task A_session_with_IFC8_handshakes_forwards_records_and_writes_commands()
    {
        using var ifc8 = new TcpListener(IPAddress.Loopback, 0);
        ifc8.Start();
        var settings = new FiasSettings
        {
            Host = "127.0.0.1",
            Port = ((IPEndPoint)ifc8.LocalEndpoint).Port,
            LinkAliveSeconds = 30,
            ReconnectSeconds = 1,
        };
        using var adapter = new FiasAdapter(settings, "instance-a", NullLogger.Instance, () => new DateTime(2026, 10, 4, 12, 0, 0));
        var published = new Collector();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var running = adapter.RunAsync(published, cts.Token);

        using var pms = await ifc8.AcceptTcpClientAsync(cts.Token);
        var stream = pms.GetStream();
        var fromAgent = FiasFraming.ReadAsync(stream, Utf8, cts.Token).GetAsyncEnumerator(cts.Token);
        async Task<string> Next()
        {
            Assert.True(await fromAgent.MoveNextAsync());
            return fromAgent.Current;
        }
        async Task Send(string record) => await stream.WriteAsync(FiasFraming.Frame(record, Utf8), cts.Token);

        await Send("LS|DA261004|TI120000|");
        Assert.Equal("LD|V#1.0|IFWW|DA261004|TI120000|", await Next());
        var requested = new List<string>();
        for (var i = 0; i < FiasAdapter.Requested.Length; i++) requested.Add(await Next());
        Assert.Contains("LR|RIGI|FLRNG#GNGFGTGLGVGAGDSFDATI|", requested);
        Assert.StartsWith("LA|", await Next(), StringComparison.Ordinal);
        Assert.False(adapter.LinkUp);
        // A command before IFC8 confirms the link fails (the platform retries it).
        var resync = adapter.Commands().Single(c => c.CommandType == "RESYNC_IN_HOUSE");
        Assert.False((await resync.ExecuteAsync(new JsonObject(), cts.Token)).Acknowledged);

        await Send("LA|DA261004|TI120000|");
        await Send("GI|RN504|G#88123|GNNile|DA261004|TI120001|");
        await Send("GI|RN504|G#88123|GNNile|DA261004|TI120001|"); // IFC8 repeats it after a hiccup
        await WaitUntil(() => published.Messages.Count == 2, cts.Token);
        Assert.True(adapter.LinkUp);
        Assert.All(published.Messages, m => Assert.Equal("FIAS_RECORD", m.type));
        Assert.Equal(published.Messages[0].id, published.Messages[1].id);
        Assert.Equal("GI|RN504|G#88123|GNNile|DA261004|TI120001|", JsonNode.Parse(published.Messages[0].payload)!["record"]!.GetValue<string>());

        Assert.True((await resync.ExecuteAsync(new JsonObject(), cts.Token)).Acknowledged);
        Assert.Equal("DR|DA261004|TI120000|", await Next());
        var status = adapter.Commands().Single(c => c.CommandType == "SET_ROOM_STATUS");
        Assert.False((await status.ExecuteAsync(new JsonObject { ["room_number"] = "504", ["status"] = "CLEAN" }, cts.Token)).Acknowledged);
        Assert.True((await status.ExecuteAsync(
            new JsonObject { ["room_number"] = "504", ["status"] = "CLEAN", ["occupied"] = false }, cts.Token)).Acknowledged);
        Assert.Equal("RE|RN504|RS3|DA261004|TI120000|", await Next());

        await Send("LE|DA261004|TI120002|");
        await WaitUntil(() => !adapter.LinkUp, cts.Token);
        // The agent comes back on its own.
        using var again = await ifc8.AcceptTcpClientAsync(cts.Token);
        Assert.Equal(2, adapter.Sessions);
        await cts.CancelAsync();
        await running;
    }

    private static async Task WaitUntil(Func<bool> condition, CancellationToken ct)
    {
        while (!condition()) await Task.Delay(20, ct);
    }

    private sealed class Collector : IMessagePublisher
    {
        private readonly Lock _lock = new();
        public List<(string id, string type, string payload)> Messages { get; } = [];

        public QueuedMessage Publish(string sourceMessageId, string messageType, string? occurredAt, string payloadJson)
        {
            lock (_lock) Messages.Add((sourceMessageId, messageType, payloadJson));
            return new QueuedMessage(Messages.Count, sourceMessageId, messageType, occurredAt, payloadJson);
        }
    }

    /// <summary>Hands out a few bytes per read, like a slow serial-to-TCP converter.</summary>
    private sealed class TrickleStream(byte[] data, int chunk) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            base.ReadAsync(buffer[..Math.Min(chunk, buffer.Length)], cancellationToken);
    }
}
