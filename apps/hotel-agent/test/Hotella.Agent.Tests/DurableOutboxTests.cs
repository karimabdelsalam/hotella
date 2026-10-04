using Hotella.Agent.Core.Queue;

namespace Hotella.Agent.Tests;

public sealed class DurableOutboxTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("hotella-agent-").FullName;

    [Fact]
    public void Messages_get_ordered_sequences_and_survive_a_restart_until_acknowledged()
    {
        var file = Path.Combine(_dir, "outbox.db");
        using (var outbox = DurableOutbox.Open(file))
        {
            Assert.Null(outbox.FirstBuffered);
            Assert.Equal(1, outbox.Append("m1", "FIAS_RECORD", null, "{\"record\":\"GI|RN504|\"}").SequenceNo);
            Assert.Equal(2, outbox.Append("m2", "FIAS_RECORD", "2026-10-04T10:00:00.000Z", "{}").SequenceNo);
            Assert.Equal(3, outbox.Append("m3", "FIAS_RECORD", null, "{}").SequenceNo);
            Assert.Equal(1, outbox.AckThrough(1));
        }
        using (var reopened = DurableOutbox.Open(file))
        {
            Assert.Equal(2, reopened.Depth);
            Assert.Equal(2, reopened.FirstBuffered);
            Assert.Equal(["m2", "m3"], reopened.Pending().Select(m => m.SourceMessageId));
            Assert.Equal(["m3"], reopened.Pending(3).Select(m => m.SourceMessageId));
            // Numbering continues after a restart, even once everything was acknowledged.
            reopened.AckThrough(3);
            Assert.Equal(4, reopened.Append("m4", "FIAS_RECORD", null, "{}").SequenceNo);
        }
    }

    [Fact]
    public void Executed_commands_are_remembered_so_a_redelivery_is_not_run_twice()
    {
        using var outbox = DurableOutbox.Open(Path.Combine(_dir, "outbox.db"));
        Assert.Null(outbox.ExecutedCommand("c1"));
        outbox.RecordCommand("c1", "FAILED", "room unknown");
        outbox.RecordCommand("c1", "ACKNOWLEDGED", null);
        Assert.Equal(("FAILED", "room unknown"), outbox.ExecutedCommand("c1"));
    }

    [Fact]
    public void Eviction_only_drops_messages_older_than_the_retention()
    {
        using var outbox = DurableOutbox.Open(Path.Combine(_dir, "outbox.db"));
        outbox.Append("m1", "FIAS_RECORD", null, "{}");
        Assert.Equal(0, outbox.Evict(TimeSpan.FromDays(30)));
        Assert.Equal(1, outbox.Evict(TimeSpan.FromSeconds(-1)));
        Assert.Equal(0, outbox.Depth);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);
}
