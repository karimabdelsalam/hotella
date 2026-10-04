using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Hotella.Agent.Core.Hosting;

namespace Hotella.Agent.Tests;

public class HostingTests
{
    [Fact]
    public void Settings_name_every_problem_an_installer_must_fix()
    {
        var empty = new AgentSettings { RenewAtRemainingFraction = 1 };
        Assert.Equal(
        [
            "Agent:Gateway is not set",
            "Agent:ConnectorCode is not set",
            "Agent:Capabilities is empty",
            "Agent:RenewAtRemainingFraction must be between 0 and 1",
        ], empty.Problems());

        var plain = new AgentSettings { Gateway = new Uri("http://agents.example"), ConnectorCode = "OPERA5_FIAS" };
        plain.Capabilities.Add("CHECKIN_EVENT");
        Assert.Equal(["Agent:Gateway must be an https:// address"], plain.Problems());

        var good = new AgentSettings { Gateway = new Uri("https://agents.example"), ConnectorCode = "OPERA5_FIAS" };
        good.Capabilities.Add("CHECKIN_EVENT");
        Assert.Empty(good.Problems());
    }

    [Theory]
    [InlineData(0, false)] // just issued
    [InlineData(59, false)] // 31 of 90 days left
    [InlineData(60, true)] // a third left
    [InlineData(89, true)]
    [InlineData(120, true)] // expired
    public void Renewal_is_due_once_a_third_of_the_lifetime_remains(int daysIn, bool due)
    {
        var notBefore = new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
        var notAfter = notBefore.AddDays(90);
        Assert.Equal(due, RenewalPolicy.IsDue(notBefore, notAfter, notBefore.AddDays(daysIn), 1.0 / 3));
    }

    [Fact]
    public void Validity_is_read_from_the_certificate()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=hotella-agent", key, HashAlgorithmName.SHA256);
        var from = new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
        using var certificate = request.CreateSelfSigned(from, from.AddDays(30));
        var (notBefore, notAfter) = RenewalPolicy.Validity(certificate.ExportCertificatePem());
        Assert.Equal(from, notBefore);
        Assert.Equal(from.AddDays(30), notAfter);
    }
}
