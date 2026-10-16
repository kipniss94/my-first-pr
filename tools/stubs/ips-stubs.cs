// Заглушки API IPS по тому, как его использует скрипт отчёта.
// System.Windows.Forms намеренно НЕ подключается — как на сервере приложений.
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Data;

namespace Intermech
{
	public interface IServiceContainerLike { object GetService(Type type); }
	public static class ApplicationServices { public static IServiceContainerLike Container; }
}
namespace Intermech.Interfaces.Client { public interface ICSharpScriptContext { } }
namespace Intermech.Kernel.Search { public class SearchStub { } }
namespace Intermech.Interfaces.PdmConfigurator
{
	public static class PDMPluginGuids { public static Guid buttonSubstitutesGuid = Guid.NewGuid(); }
}
namespace Intermech.Interfaces
{
	public interface IDBAttribute { DateTime AsDateTime { get; } double AsDouble { get; } string AsString { get; } bool IsNull { get; } }
	public interface IDBObject { long ObjectID { get; } string Caption { get; } int ObjectType { get; } DateTime CreateDate { get; } IDBAttribute GetAttributeByID(int id); }
	public interface IUserSession { IDBObject GetObject(long id); object GetCustomService(Type type); Guid SessionGUID { get; } }
}
namespace Intermech.Interfaces.Document
{
	public class DocumentTreeNode
	{
		public virtual DocumentTreeNode FindNode(string name) { return null; }
		public virtual DocumentTreeNode CloneFromTemplate(bool a, bool b) { return null; }
		public virtual void AddChildNode(DocumentTreeNode node, bool a, bool b) { }
		public virtual DocumentTreeNode FindFirstChildNodeByName(string name) { return null; }
		public virtual void UpdateLayout(bool a) { }
	}
	public class TextData : DocumentTreeNode { public void AssignText(string t, bool a, bool b, bool c) { } }
	public class ImDocumentData
	{
		public DocumentTreeNode Template = new DocumentTreeNode();
		public virtual DocumentTreeNode FindFirstNodeFromTemplate_Recursive(string name) { return null; }
	}
}
namespace Intermech.Expert.Scenarios
{
	public class ScriptResult { public ScriptResult(bool ok, Intermech.Interfaces.Document.ImDocumentData doc) { } }
	public static class ScenarioFunc { public static System.Collections.Generic.List<string> Written = new System.Collections.Generic.List<string>();
		public static void WriteNodeRow(Intermech.Interfaces.Document.DocumentTreeNode row, string cell, string value) { Written.Add(cell + " = " + value); } }
}
namespace Intermech.Interfaces.Calendars
{
	public enum DayType { Working, Holiday, Weekend, PreHoliday }
	public interface IWorkTimePeriod { int StartHours { get; } int FinishHours { get; } int StartMinutes { get; } int FinishMinutes { get; } }
	public interface ICalendarDay { DayType DayType { get; } IReadOnlyList<IWorkTimePeriod> WorkTimePeriods { get; } }
	public interface ICalendar { ICalendarDay GetDayByDate(DateTime date); }
	public interface ICalendarsService { ICalendar GetCalendar(Intermech.Interfaces.IUserSession session, long id); }
}
namespace Intermech.Interfaces.Compositions
{
	public enum AttributeSourceTypes { Object }
	public enum ColumnContents { ID, Text }
	public enum ColumnNameMapping { Guid }
	public enum SortOrders { NONE, ASC }
	public class ColumnDescriptor
	{
		public ColumnDescriptor(int id, AttributeSourceTypes s, ColumnContents c, ColumnNameMapping m, SortOrders o, int order) { }
	}
	public interface ICompositionLoadService
	{
		DataTable LoadComposition(Guid session, long objectId, int objectType, IEnumerable<int> relationTypes,
			IEnumerable<int> objectTypes, IEnumerable<ColumnDescriptor> columns, bool composition, bool flag,
			object a, object b, object c, HybridDictionary tags, int levels);
	}
}
