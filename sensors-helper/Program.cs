// PulseSensors — Pulse's built-in sensor engine.
// Wraps LibreHardwareMonitorLib (MPL-2.0) and streams one JSON line per tick:
//   {"available":true,"sensors":[{id,hw,category,name,value,unit}, …]}
// Exits when stdin closes, so it can never outlive the Pulse process that spawned it.
using System.Text.Json;
using LibreHardwareMonitor.Hardware;

class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);
    public void VisitHardware(IHardware hardware)
    {
        hardware.Update();
        foreach (var sub in hardware.SubHardware) sub.Accept(this);
    }
    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}

class Program
{
    static string Cat(SensorType t) => t switch
    {
        SensorType.Temperature => "Temperatures",
        SensorType.Fan => "Fans",
        SensorType.Voltage => "Voltages",
        SensorType.Power => "Powers",
        SensorType.Clock => "Clocks",
        SensorType.Load => "Load",
        SensorType.Control => "Controls",
        SensorType.Current => "Currents",
        SensorType.Data or SensorType.SmallData => "Data",
        SensorType.Throughput => "Throughput",
        SensorType.Level => "Levels",
        _ => t.ToString(),
    };

    static string Unit(SensorType t) => t switch
    {
        SensorType.Temperature => "°C",
        SensorType.Fan => "RPM",
        SensorType.Voltage => "V",
        SensorType.Power => "W",
        SensorType.Clock => "MHz",
        SensorType.Load or SensorType.Control or SensorType.Level => "%",
        SensorType.Current => "A",
        SensorType.Data => "GB",
        SensorType.SmallData => "MB",
        SensorType.Throughput => "B/s",
        _ => "",
    };

    static void Collect(IHardware hw, string top, List<object> list, Dictionary<string, int> seen)
    {
        foreach (var sensor in hw.Sensors)
        {
            if (sensor.Value is not float v || float.IsNaN(v) || float.IsInfinity(v)) continue;
            var cat = Cat(sensor.SensorType);
            var id = $"{top}|{cat}|{sensor.Name}";
            if (seen.TryGetValue(id, out var n)) { seen[id] = n + 1; id = $"{id} #{n + 1}"; }
            else seen[id] = 1;
            list.Add(new { id, hw = top, category = cat, name = sensor.Name, value = Math.Round(v, 3), unit = Unit(sensor.SensorType) });
        }
        foreach (var sub in hw.SubHardware) Collect(sub, top, list, seen);
    }

    static void Main(string[] args)
    {
        int intervalMs = args.Length > 0 && int.TryParse(args[0], out var ms) ? Math.Max(1000, ms) : 3000;

        // Die with the parent: Pulse holds our stdin pipe open; EOF means it's gone.
        new Thread(() => { try { while (Console.In.Read() != -1) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();

        var computer = new Computer
        {
            IsCpuEnabled = true,
            IsMotherboardEnabled = true,
            IsMemoryEnabled = true,
            IsGpuEnabled = true,
            IsStorageEnabled = true,
            IsControllerEnabled = true,
            IsPsuEnabled = true,
            IsBatteryEnabled = true,
        };
        computer.Open();
        var visitor = new UpdateVisitor();
        var seen = new Dictionary<string, int>();

        while (true)
        {
            try
            {
                computer.Accept(visitor);
                var list = new List<object>();
                seen.Clear();
                foreach (var hw in computer.Hardware) Collect(hw, hw.Name, list, seen);
                Console.WriteLine(JsonSerializer.Serialize(new { available = true, sensors = list }));
                Console.Out.Flush();
            }
            catch (Exception ex)
            {
                Console.WriteLine(JsonSerializer.Serialize(new { available = false, error = ex.Message }));
                Console.Out.Flush();
            }
            Thread.Sleep(intervalMs);
        }
    }
}
