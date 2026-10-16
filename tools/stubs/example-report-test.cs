using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Data;
using System.Linq;
using Intermech;
using Intermech.Interfaces;
using Intermech.Interfaces.Calendars;
using Intermech.Interfaces.Compositions;
using Intermech.Interfaces.Document;
using Intermech.Expert.Scenarios;

class Attr : IDBAttribute
{
	public DateTime AsDateTime { get { return DateTime.MinValue; } }
	public double AsDouble { get { return 0; } } public string AsString { get { return ""; } } public bool IsNull { get { return false; } }
}
class Obj : IDBObject
{
	public long ObjectID { get; set; } public string Caption { get { return "ЗК-" + ObjectID; } } public int ObjectType { get { return 1578; } }
	public DateTime CreateDate { get { return new DateTime(2026, 9, 1); } }
	public IDBAttribute GetAttributeByID(int id) { return new Attr(); }
}
class Comp : ICompositionLoadService
{
	static string D(int m, int d, int h) { return new DateTime(2026, m, d, h, 0, 0).ToString(); }
	public DataTable LoadComposition(Guid s, long objectId, int objectType, IEnumerable<int> rel, IEnumerable<int> types,
		IEnumerable<ColumnDescriptor> cols, bool c, bool f, object a, object b, object x, HybridDictionary tags, int levels)
	{
		DataTable t = new DataTable();
		int relation = rel.First();
		if (relation == 1027)   // задачи проекта
		{
			foreach (string g in new[] { "cad00029", "cad00047", "cad015d9", "cad015da", "cad002cb", "cad0132d", "cad00e97" })
				t.Columns.Add(g + "-306c-11d8-b4e9-00304f19f545");
			t.Rows.Add("1", "A: завершена 1-го числа", D(9, 30, 9), D(10, 1, 12), "", "", "8 ч");
			t.Rows.Add("2", "B: короткая", D(10, 1, 9), D(10, 1, 15), "", "", "4 ч");
			t.Rows.Add("3", "C: без фактического начала", "", D(10, 2, 12), "", "", "2 ч");
			t.Rows.Add("4", "D: без исполнителя", D(10, 1, 9), D(10, 1, 10), "", "", "1 ч");
			t.Rows.Add("5", "E: без исполнителя", D(10, 1, 9), D(10, 1, 10), "", "", "1 ч");
		}
		else if (relation == 1026)   // исполнители задачи
		{
			t.Columns.Add("cad00029-306c-11d8-b4e9-00304f19f545"); t.Columns.Add("cad00047-306c-11d8-b4e9-00304f19f545");
			if (objectId == 1 || objectId == 3) t.Rows.Add("11", "Иванов И.И.");
			if (objectId == 2) t.Rows.Add("12", "Петров П.П.");
		}
		return t;   // изделия (1032) — пусто
	}
}
class Session : IUserSession
{
	public IDBObject GetObject(long id) { return new Obj { ObjectID = id }; }
	public object GetCustomService(Type t) { return new Comp(); }
	public Guid SessionGUID { get { return Guid.Empty; } }
}
class Node : DocumentTreeNode
{
	public override DocumentTreeNode FindNode(string name) { return new Node(); }
	public override DocumentTreeNode FindFirstChildNodeByName(string name) { return new Node(); }
	public override DocumentTreeNode CloneFromTemplate(bool a, bool b) { ScenarioFunc.Written.Add("--- строка"); return new Node(); }
}
class Doc : ImDocumentData
{
	public Doc() { Template = new Node(); }
	public override DocumentTreeNode FindFirstNodeFromTemplate_Recursive(string name) { return new Node(); }
}
class Period : IWorkTimePeriod
{
	public int StartHours { get; set; } public int FinishHours { get; set; } public int StartMinutes { get; set; } public int FinishMinutes { get; set; }
}
class Day : ICalendarDay
{
	public DayType DayType { get { return DayType.Working; } }
	public IReadOnlyList<IWorkTimePeriod> WorkTimePeriods { get { return new List<IWorkTimePeriod> { new Period { StartHours = 8, FinishHours = 17 } }; } }
}
class Cal : ICalendar
{
	public int Calls;
	public ICalendarDay GetDayByDate(DateTime d) { Calls++; return new Day(); }
}
class CalSvc : ICalendarsService { public Cal Cal = new Cal(); public ICalendar GetCalendar(IUserSession s, long id) { return Cal; } }
class Container : IServiceContainerLike { public CalSvc Svc = new CalSvc(); public object GetService(Type t) { return Svc; } }

static class Test
{
	static int Main()
	{
		Container container = new Container();
		ApplicationServices.Container = container;
		object script = Activator.CreateInstance(Type.GetType("Script"));
		DateTime started = DateTime.Now;
		script.GetType().GetMethod("Execute").Invoke(script, new object[] { new Session(), new Doc(), new long[] { 100 } });
		foreach (string line in ScenarioFunc.Written) Console.WriteLine("  " + line);
		Console.WriteLine("  обращений к календарю: " + container.Svc.Cal.Calls + ", время: " + (DateTime.Now - started).TotalMilliseconds.ToString("0") + " мс");

		string[] expected = {
			"--- строка", "Инженер конструктор = Иванов И.И.", "Время выполн = 8", "Время вне плана = 4",   // A: 720 мин факт − 480 план
			"--- строка",                                                                                       // C: без начала — время не считается
			"--- строка", "Инженер конструктор = Петров П.П.", "Время выполн = 4", "Время вне плана = 2" };    // B: 360 − 240
		bool ok = ScenarioFunc.Written.SequenceEqual(expected) && container.Svc.Cal.Calls < 10;
		Console.WriteLine(ok ? "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : "ПРОВАЛ");
		return ok ? 0 : 1;
	}
}
