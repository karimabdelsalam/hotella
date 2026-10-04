using System.Text.Json.Nodes;
using Hotella.Agent.Core.Json;
using Hotella.Agent.Core.Security;

namespace Hotella.Agent.Tests;

/// <summary>The agent must produce the platform's canonical bytes and accept its signatures (shared vector).</summary>
public sealed class CanonicalJsonTests
{
    private static JsonObject Vector() =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "vectors", "command-frame.json")))!
            .AsObject();

    [Fact]
    public void Canonical_bytes_match_the_platform()
    {
        var vector = Vector();
        var frame = vector["frame"]!.AsObject().DeepClone().AsObject();
        frame.Remove("signature");
        Assert.Equal(vector["canonical"]!.GetValue<string>(), CanonicalJson.Serialize(frame));
    }

    [Fact]
    public void A_platform_signature_verifies_and_any_change_breaks_it()
    {
        var vector = Vector();
        var verifier = new CommandSignature(vector["public_key_pem"]!.GetValue<string>());
        var frame = vector["frame"]!.AsObject();
        Assert.True(verifier.Verify(frame.DeepClone().AsObject()));
        var tampered = frame.DeepClone().AsObject();
        tampered["command_type"] = "SET_ROOM_STATUZ";
        Assert.False(verifier.Verify(tampered));
        var unsigned = frame.DeepClone().AsObject();
        unsigned.Remove("signature");
        Assert.False(verifier.Verify(unsigned));
    }

    [Theory]
    [InlineData(0d, "0")]
    [InlineData(1d, "1")]
    [InlineData(0.5, "0.5")]
    [InlineData(-12.25, "-12.25")]
    [InlineData(12345678901d, "12345678901")]
    [InlineData(1e21, "1e+21")]
    [InlineData(1.5e-7, "1.5e-7")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(123456789012345680000d, "123456789012345680000")]
    [InlineData(0.1 + 0.2, "0.30000000000000004")]
    public void Numbers_are_written_like_ECMAScript(double value, string expected) =>
        Assert.Equal(expected, CanonicalJson.FormatNumber(value));

    [Fact]
    public void Negative_zero_is_written_as_zero() => Assert.Equal("0", CanonicalJson.FormatNumber(-0d));

    [Fact]
    public void Keys_sort_by_UTF16_code_unit_and_strings_escape_like_JSON_stringify()
    {
        var node = JsonNode.Parse("{\"b\":1,\"a\":{\"z\":\"\\u0001\\t\\u2028\",\"Z\":true},\"\u00e9\":null}");
        Assert.Equal(
            "{\"a\":{\"Z\":true,\"z\":\"\\u0001\\t\u2028\"},\"b\":1,\"\u00e9\":null}",
            CanonicalJson.Serialize(node));
    }
}
