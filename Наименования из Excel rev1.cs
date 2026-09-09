using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Intermech;
using Intermech.Client.Core;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;

// ===========================================================================
// Обновление наименований объектов по таблице Excel.
//
// В файле два столбца: идентификатор версии объекта и наименование
// (первая строка может быть заголовком — она пропускается, если в первом
// столбце не число).
//
// Скрипт проходит по всем строкам, находит объект по идентификатору версии
// и записывает ему наименование из таблицы. Объект, которого нет в базе,
// и строка с пустым наименованием пропускаются; в конце выводится сводка.
//
// Таблица читается через Excel (COM, позднее связывание), поэтому на
// рабочем месте должен быть установлен Microsoft Excel. Значения берутся
// одним обращением к UsedRange.Value2 — по ячейкам скрипт не ходит.
// ===========================================================================
public class Script
{
	public ICSharpScriptClientContext ScriptContext { get; set; }

	// Атрибут «Наименование»
	private readonly Guid AttrNameGuid = new Guid("cad00020-306c-11d8-b4e9-00304f19f545");
	private const string AttrNameName = "Наименование";

	private const string DialogCaption = "Наименования из Excel";
	private const int MaxProblemsShown = 15;   // сколько проблемных строк показывать в сводке

	// Строка таблицы
	private class TableRow
	{
		public int RowNumber;   // номер строки в файле — для сообщений
		public long ObjectID;   // идентификатор версии объекта
		public string Name;     // наименование
	}

	public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
	{
		try
		{
			IUserSession session = parameters.UserSession;

			// ==================================================
			// 1. ВЫБОР ФАЙЛА
			// ==================================================
			string filePath = SelectExcelFile();
			if (string.IsNullOrEmpty(filePath))
				return parameters;

			// ==================================================
			// 2. ЧТЕНИЕ ТАБЛИЦЫ
			// ==================================================
			List<string> problems = new List<string>();
			List<TableRow> rows;

			Cursor.Current = Cursors.WaitCursor;
			try
			{
				rows = ReadRows(filePath, problems);
			}
			catch (Exception readEx)
			{
				Show("Не удалось прочитать файл:" + Environment.NewLine + readEx.Message, MessageBoxIcon.Error);
				return parameters;
			}
			finally
			{
				Cursor.Current = Cursors.Default;
			}

			if (rows.Count == 0)
			{
				Show("В файле не найдено ни одной строки с идентификатором версии объекта.", MessageBoxIcon.Warning);
				return parameters;
			}

			// ==================================================
			// 3. ПОДТВЕРЖДЕНИЕ
			// ==================================================
			DialogResult answer = MessageBox.Show(
				"Файл: " + filePath + Environment.NewLine +
				"Строк к обработке: " + rows.Count + Environment.NewLine + Environment.NewLine +
				"Записать наименования из таблицы в найденные объекты?",
				DialogCaption, MessageBoxButtons.YesNo, MessageBoxIcon.Question);

			if (answer != DialogResult.Yes)
				return parameters;

			// ==================================================
			// 4. ОБНОВЛЕНИЕ ОБЪЕКТОВ
			// ==================================================
			int updated = 0;     // наименование записано
			int unchanged = 0;   // наименование уже совпадало
			int notFound = 0;    // объект не найден

			Cursor.Current = Cursors.WaitCursor;
			try
			{
				foreach (TableRow row in rows)
				{
					try
					{
						IDBObject obj = session.GetObject(row.ObjectID);
						if (obj == null)
						{
							notFound++;
							AddProblem(problems, "строка " + row.RowNumber + ": объект " + row.ObjectID + " не найден");
							continue;
						}

						IDBAttribute attribute = obj.GetAttributeByGuid(AttrNameGuid);
						if (attribute == null)
							attribute = obj.Attributes.FindByName(AttrNameName);

						if (attribute == null)
						{
							AddProblem(problems, "строка " + row.RowNumber + ": у объекта " + row.ObjectID +
								" нет атрибута «" + AttrNameName + "»");
							continue;
						}

						string currentName = attribute.Value == null ? string.Empty : attribute.Value.ToString().Trim();
						if (string.Compare(currentName, row.Name, StringComparison.CurrentCulture) == 0)
						{
							unchanged++;
							continue;
						}

						attribute.Value = row.Name;
						updated++;
					}
					catch (Exception rowEx)
					{
						AddProblem(problems, "строка " + row.RowNumber + ": " + rowEx.Message);
					}
				}
			}
			finally
			{
				Cursor.Current = Cursors.Default;
			}

			ShowResult(rows.Count, updated, unchanged, notFound, problems);
		}
		catch (Exception ex)
		{
			Show("Ошибка: " + ex.Message, MessageBoxIcon.Error);
		}

		return parameters;
	}

	// =======================================================================
	// ЧТЕНИЕ ФАЙЛА
	// =======================================================================

	private string SelectExcelFile()
	{
		using (OpenFileDialog dialog = new OpenFileDialog())
		{
			dialog.Title = "Выберите таблицу с наименованиями";
			dialog.Filter = "Книги Excel (*.xlsx;*.xlsm;*.xls)|*.xlsx;*.xlsm;*.xls|Все файлы (*.*)|*.*";
			dialog.CheckFileExists = true;

			return dialog.ShowDialog() == DialogResult.OK ? dialog.FileName : null;
		}
	}

	// Чтение первого листа: 1-й столбец — идентификатор версии объекта,
	// 2-й — наименование. Значения берутся одним обращением к UsedRange.Value2.
	private List<TableRow> ReadRows(string filePath, List<string> problems)
	{
		List<TableRow> rows = new List<TableRow>();

		Type excelType = Type.GetTypeFromProgID("Excel.Application");
		if (excelType == null)
			throw new Exception("Microsoft Excel не установлен на этом компьютере.");

		object excel = null;
		object workbooks = null;
		object workbook = null;
		object worksheets = null;
		object worksheet = null;
		object usedRange = null;

		try
		{
			excel = Activator.CreateInstance(excelType);
			SetProperty(excel, "Visible", false);
			SetProperty(excel, "DisplayAlerts", false);

			workbooks = GetProperty(excel, "Workbooks");
			workbook = Call(workbooks, "Open", new object[] { filePath });

			worksheets = GetProperty(workbook, "Worksheets");
			worksheet = GetProperty(worksheets, "Item", new object[] { 1 });

			usedRange = GetProperty(worksheet, "UsedRange");
			Array values = GetProperty(usedRange, "Value2") as Array;

			if (values == null)
				return rows;

			int firstRow = values.GetLowerBound(0);
			int lastRow = values.GetUpperBound(0);
			int firstColumn = values.GetLowerBound(1);
			int lastColumn = values.GetUpperBound(1);

			if (lastColumn - firstColumn < 1)
				throw new Exception("В таблице должно быть два столбца: идентификатор версии объекта и наименование.");

			for (int rowIndex = firstRow; rowIndex <= lastRow; rowIndex++)
			{
				object idValue = values.GetValue(rowIndex, firstColumn);
				object nameValue = values.GetValue(rowIndex, firstColumn + 1);

				long objectID;
				if (!TryGetObjectID(idValue, out objectID))
					continue; // заголовок или строка без идентификатора

				string name = nameValue == null ? string.Empty : nameValue.ToString().Trim();
				if (string.IsNullOrEmpty(name))
				{
					AddProblem(problems, "строка " + rowIndex + ": наименование не заполнено");
					continue;
				}

				TableRow row = new TableRow();
				row.RowNumber = rowIndex;
				row.ObjectID = objectID;
				row.Name = name;

				rows.Add(row);
			}
		}
		finally
		{
			// Закрываем книгу и Excel, освобождаем COM-объекты
			if (workbook != null)
			{
				try { Call(workbook, "Close", new object[] { false }); }
				catch { }
			}

			if (excel != null)
			{
				try { Call(excel, "Quit", null); }
				catch { }
			}

			Release(usedRange);
			Release(worksheet);
			Release(worksheets);
			Release(workbook);
			Release(workbooks);
			Release(excel);
		}

		return rows;
	}

	// Идентификатор версии объекта: Excel отдаёт числа как double,
	// но значение может прийти и строкой.
	private bool TryGetObjectID(object value, out long objectID)
	{
		objectID = 0;

		if (value == null)
			return false;

		try
		{
			if (value is double || value is int || value is long || value is decimal)
			{
				objectID = Convert.ToInt64(value);
				return objectID > 0;
			}

			string text = value.ToString().Trim();
			if (text.Length == 0)
				return false;

			return long.TryParse(text, out objectID) && objectID > 0;
		}
		catch
		{
			return false;
		}
	}

	// =======================================================================
	// РАБОТА С COM (позднее связывание, как при работе с Notes)
	// =======================================================================

	private object GetProperty(object target, string name)
	{
		return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, null);
	}

	private object GetProperty(object target, string name, object[] arguments)
	{
		return target.GetType().InvokeMember(name, BindingFlags.GetProperty, null, target, arguments);
	}

	private void SetProperty(object target, string name, object value)
	{
		target.GetType().InvokeMember(name, BindingFlags.SetProperty, null, target, new object[] { value });
	}

	private object Call(object target, string name, object[] arguments)
	{
		return target.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, target, arguments);
	}

	private void Release(object comObject)
	{
		if (comObject == null)
			return;

		try { Marshal.ReleaseComObject(comObject); }
		catch { }
	}

	// =======================================================================
	// СООБЩЕНИЯ
	// =======================================================================

	private void AddProblem(List<string> problems, string text)
	{
		problems.Add(text);
	}

	private void Show(string text, MessageBoxIcon icon)
	{
		MessageBox.Show(text, DialogCaption, MessageBoxButtons.OK, icon);
	}

	// Сводка: сколько строк обработано, обновлено, пропущено, и первые
	// проблемные строки.
	private void ShowResult(int total, int updated, int unchanged, int notFound, List<string> problems)
	{
		StringBuilder text = new StringBuilder();
		text.Append("Строк обработано: " + total);
		text.Append(Environment.NewLine + "Наименований записано: " + updated);
		text.Append(Environment.NewLine + "Уже совпадало: " + unchanged);
		text.Append(Environment.NewLine + "Объектов не найдено: " + notFound);

		if (problems.Count == 0)
		{
			Show(text.ToString(), MessageBoxIcon.Information);
			return;
		}

		text.Append(Environment.NewLine + Environment.NewLine + "Замечания (" + problems.Count + "):");

		int shown = 0;
		foreach (string problem in problems)
		{
			if (shown >= MaxProblemsShown)
			{
				text.Append(Environment.NewLine + "- ... и ещё " + (problems.Count - shown));
				break;
			}

			text.Append(Environment.NewLine + "- " + problem);
			shown++;
		}

		Show(text.ToString(), MessageBoxIcon.Warning);
	}
}
