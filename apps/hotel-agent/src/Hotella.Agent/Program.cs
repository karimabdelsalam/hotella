using Hotella.Agent;

// hotella-agent <command>: run (default; as a service or in the foreground), enroll, status, secret, update, opera-db,
// setup (installers), version.
return args.FirstOrDefault() switch
{
    null or "run" => await AgentHost.RunAsync(args.Skip(1).ToArray()),
    "enroll" => await Cli.EnrollAsync(args.Skip(1).ToArray()),
    "status" => Cli.Status(args.Skip(1).ToArray()),
    "secret" => await Cli.SecretAsync(args.Skip(1).ToArray()),
    "update" => await Cli.UpdateAsync(args.Skip(1).ToArray()),
    "opera-db" => await Cli.OperaDbAsync(args.Skip(1).ToArray()),
    "setup" => await Cli.SetupAsync(args.Skip(1).ToArray()),
    "version" or "--version" => Cli.Version(),
    _ => Cli.Usage(),
};
