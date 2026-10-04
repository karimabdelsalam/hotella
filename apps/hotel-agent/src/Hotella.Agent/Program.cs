using Hotella.Agent;

// hotella-agent <command>: run (default; as a service or in the foreground), enroll, status, version.
return args.FirstOrDefault() switch
{
    null or "run" => await AgentHost.RunAsync(args.Skip(1).ToArray()),
    "enroll" => await Cli.EnrollAsync(args.Skip(1).ToArray()),
    "status" => Cli.Status(args.Skip(1).ToArray()),
    "version" or "--version" => Cli.Version(),
    _ => Cli.Usage(),
};
