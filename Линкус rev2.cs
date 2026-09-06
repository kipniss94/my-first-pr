using System;
using System.Collections.Generic;
using System.Data;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Intermech;
using Intermech.Client.Core;
using Intermech.Forums;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;
using Intermech.Interfaces.Compositions;
using Intermech.Interfaces.Workflow;
using Intermech.Kernel.Search;

// ===========================================================================
// Звонок контакту через Linkus и регистрация результата.
//
// Скрипт вызывается с карточки контакта и:
//   1) копирует телефон в буфер обмена и эмулирует Ctrl+Shift+E (звонок);
//   2) спрашивает дату следующего контакта и комментарий;
//   3) у родительского объекта (предприятия) обновляет «Дату последнего
//      контакта» и «Дату следующего контакта»;
//   4) пишет результат разговора в обсуждение предприятия.
//
// Важное отличие от прежней версии: если атрибут даты у предприятия ещё
// ни разу не заполнялся, IPS не возвращает его обработчик, и запись молча
// пропускалась. Теперь такой атрибут объекту добавляется (EnsureAttribute),
// а результат записи проверяется чтением значения.
// ===========================================================================
public class Script
{
	public ICSharpScriptClientContext ScriptContext { get; set; }

	// --- метаданные (GUID берутся из конфигуратора базы) ---
	private readonly Guid AttrPhoneGuid = new Guid("6ba3b789-c888-48ad-9863-ea533b3c7939");        // Телефон
	private readonly Guid AttrDesignationGuid = new Guid("cad0001f-306c-11d8-b4e9-00304f19f545");  // Обозначение
	private readonly Guid AttrLastContactGuid = new Guid("70448372-c797-4a51-b923-a810436107b5");  // Дата последнего контакта
	private readonly Guid AttrNextContactGuid = new Guid("50676414-494a-498d-bae1-4e1af2b7e172");  // Дата следующего контакта
	private readonly Guid RelationSimpleGuid = new Guid("cad00023-306c-11d8-b4e9-00304f19f545");   // Простая связь между объектами

	private const string AttrLastContactName = "Дата последнего контакта";
	private const string AttrNextContactName = "Дата следующего контакта";

	// --- тексты ---
	private const string DialogCaption = "Звонок";
	private const string ForumTopic = "Звонок";
	private const string NoAnswerText = "Не дозвонился";

	// --- параметры эмуляции звонка ---
	private const int ClipboardDelayMs = 100;   // пауза после копирования номера в буфер
	private const int CallDelayMs = 1500;       // пауза после нажатия Ctrl+Shift+E

	// Результат диалога ввода
	public class InputResult
	{
		public string Comment { get; set; }
		public DateTime SelectedDate { get; set; }
	}

	public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
	{
		// Замечания, не мешающие выполнить звонок: показываются одним сообщением в конце
		List<string> problems = new List<string>();
		string savedClipboard = null;

		try
		{
			IUserSession session = parameters.UserSession;

			// ==================================================
			// 1. ДАННЫЕ КОНТАКТА
			// ==================================================
			IDBObject contact = session.GetObject(parameters.ObjectID);
			if (contact == null)
			{
				Show("Не удалось получить контакт, с карточки которого вызван скрипт.", MessageBoxIcon.Error);
				return parameters;
			}

			string phoneValue = GetAttributeText(contact, AttrPhoneGuid);
			if (string.IsNullOrEmpty(phoneValue))
			{
				Show("Атрибут «Телефон» не заполнен — звонок невозможен.", MessageBoxIcon.Warning);
				return parameters;
			}

			string contactGuidStr = contact.ObjectGUID.ToString();
			string contactTitle = GetAttributeText(contact, AttrDesignationGuid);
			if (string.IsNullOrEmpty(contactTitle))
				contactTitle = contact.Caption ?? "Без названия";

			// ==================================================
			// 2. ЗВОНОК (Linkus вызывается сочетанием Ctrl+Shift+E)
			// ==================================================
			savedClipboard = ReadClipboard();

			try
			{
				Clipboard.SetText(phoneValue);
				Thread.Sleep(ClipboardDelayMs);
				PressCtrlShiftE();
				Thread.Sleep(CallDelayMs);
			}
			catch (Exception ex)
			{
				problems.Add("телефония: " + ex.Message);
			}

			// ==================================================
			// 3. РЕЗУЛЬТАТ РАЗГОВОРА
			// ==================================================
			InputResult dialogResult = ShowCallResultDialog();
			if (dialogResult == null)
				return parameters; // пользователь отменил ввод

			// ==================================================
			// 4. ОБНОВЛЕНИЕ ДАТ У ПРЕДПРИЯТИЯ
			// ==================================================
			ICompositionLoadService compositionLoadService =
				session.GetCustomService(typeof(ICompositionLoadService)) as ICompositionLoadService;

			if (compositionLoadService == null)
			{
				Show("Не удалось получить службу чтения составов (ICompositionLoadService).", MessageBoxIcon.Error);
				return parameters;
			}

			List<int> parentIds = FindParentIds(compositionLoadService, session, contact);
			if (parentIds.Count == 0)
			{
				Show("Предприятие для этого контакта не найдено: даты не обновлены, запись в обсуждение не сделана.",
					MessageBoxIcon.Warning);
				return parameters;
			}

			int parentId = parentIds[0];
			IDBObject parentObj = session.GetObject(parentId);
			if (parentObj == null)
			{
				Show("Не удалось получить предприятие (идентификатор " + parentId + ").", MessageBoxIcon.Error);
				return parameters;
			}

			DateTime lastContact = DateTime.Now;
			DateTime nextContact = dialogResult.SelectedDate.Date;

			bool lastSaved = SetDateValue(session, parentObj, AttrLastContactGuid, AttrLastContactName, lastContact, problems);
			bool nextSaved = SetDateValue(session, parentObj, AttrNextContactGuid, AttrNextContactName, nextContact, problems);

			// ==================================================
			// 5. ЗАПИСЬ В ОБСУЖДЕНИЕ ПРЕДПРИЯТИЯ
			// ==================================================
			try
			{
				StringBuilder text = new StringBuilder();
				text.Append("Результат общения с [ref=\"" + contactGuidStr + "\"]" + contactTitle + "[/ref]: ");
				text.Append(Environment.NewLine);
				text.Append(dialogResult.Comment == null ? string.Empty : dialogResult.Comment.Trim());

				SendMessage(session, parentId, ForumTopic, text.ToString());
			}
			catch (Exception forumEx)
			{
				problems.Add("запись в обсуждение: " + forumEx.Message);
			}

			ShowResult(lastSaved, nextSaved, lastContact, nextContact, problems);
		}
		catch (Exception ex)
		{
			Show("Ошибка: " + ex.Message, MessageBoxIcon.Error);
		}
		finally
		{
			// Возвращаем в буфер обмена то, что там было до звонка
			if (savedClipboard != null)
			{
				try { Clipboard.SetText(savedClipboard); }
				catch { }
			}
		}

		return parameters;
	}

	// =======================================================================
	// АТРИБУТЫ
	// =======================================================================

	private string GetAttributeText(IDBObject obj, Guid attributeGuid)
	{
		IDBAttribute attribute = obj.GetAttributeByGuid(attributeGuid);
		return (attribute == null || attribute.Value == null)
			? string.Empty
			: attribute.Value.ToString().Trim();
	}

	// Запись даты с проверкой результата: значение перечитывается, поэтому
	// «тихих» пропусков записи больше не будет.
	private bool SetDateValue(IUserSession session, IDBObject obj, Guid attributeGuid,
		string attributeName, DateTime value, List<string> problems)
	{
		IDBAttribute attribute = EnsureAttribute(session, obj, attributeGuid);
		if (attribute == null)
		{
			problems.Add("атрибут «" + attributeName + "» отсутствует у предприятия, и добавить его не удалось");
			return false;
		}

		try
		{
			attribute.Value = value;
		}
		catch (Exception ex)
		{
			problems.Add("не удалось записать «" + attributeName + "»: " + ex.Message);
			return false;
		}

		// Проверка: значение действительно оказалось в атрибуте
		try
		{
			IDBAttribute saved = obj.GetAttributeByGuid(attributeGuid);
			if (saved == null || saved.Value == null)
			{
				problems.Add("значение «" + attributeName + "» не сохранилось");
				return false;
			}
		}
		catch
		{
			// значение недоступно для чтения — считаем запись выполненной
		}

		return true;
	}

	// Обработчик атрибута объекта.
	//
	// Если атрибут объекту ещё не присвоен (у предприятия дата ни разу
	// не заполнялась), GetAttributeByGuid возвращает null — раньше запись
	// в этом случае молча пропускалась. Здесь атрибут сначала добавляется
	// объекту, и только потом берётся его обработчик. Способ добавления
	// зависит от версии API, поэтому варианты перебираются по именам методов.
	private IDBAttribute EnsureAttribute(IUserSession session, IDBObject obj, Guid attributeGuid)
	{
		IDBAttribute attribute = obj.GetAttributeByGuid(attributeGuid);
		if (attribute != null)
			return attribute;

		int attributeID = -1;
		try
		{
			attributeID = MetaDataHelper.GetAttributeTypeID(attributeGuid.ToString());
		}
		catch
		{
			return null; // атрибута с таким идентификатором нет в базе
		}

		if (attributeID <= 0)
			return null;

		// 1) коллекция атрибутов объекта
		TryInvoke(obj.Attributes, new string[] { "Add", "AddAttribute", "AddNew" },
			new object[] { attributeID });

		attribute = obj.GetAttributeByGuid(attributeGuid);
		if (attribute != null)
			return attribute;

		// 2) сам объект
		TryInvoke(obj, new string[] { "AddAttribute", "AddObjectAttribute" },
			new object[] { attributeID });

		attribute = obj.GetAttributeByGuid(attributeGuid);
		if (attribute != null)
			return attribute;

		// 3) пользовательская сессия
		TryInvoke(session, new string[] { "AddObjectAttribute" },
			new object[] { obj.ObjectID, attributeID });

		return obj.GetAttributeByGuid(attributeGuid);
	}

	// Вызов первого подходящего метода по имени и количеству аргументов.
	private bool TryInvoke(object target, string[] methodNames, object[] arguments)
	{
		if (target == null)
			return false;

		foreach (MethodInfo method in target.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance))
		{
			if (Array.IndexOf(methodNames, method.Name) < 0)
				continue;

			ParameterInfo[] methodParameters = method.GetParameters();
			if (methodParameters.Length != arguments.Length)
				continue;

			try
			{
				object[] converted = new object[arguments.Length];
				for (int i = 0; i < arguments.Length; i++)
					converted[i] = Convert.ChangeType(arguments[i], methodParameters[i].ParameterType);

				method.Invoke(target, converted);
				return true;
			}
			catch
			{
				// сигнатура не подошла — пробуем следующий метод
			}
		}

		return false;
	}

	// =======================================================================
	// ПОИСК ПРЕДПРИЯТИЯ
	// =======================================================================

	// Родитель ищется по простой связи между объектами; если так ничего
	// не найдено — по всем типам связей.
	private List<int> FindParentIds(
		ICompositionLoadService compositionLoadService, IUserSession session, IDBObject contact)
	{
		List<int> relationTypes = new List<int>();
		relationTypes.Add(MetaDataHelper.GetRelationTypeID(RelationSimpleGuid));

		List<int> parentIds = Load(
			compositionLoadService, session,
			(int)contact.ObjectID, contact.ObjectType, relationTypes, false);

		if (parentIds.Count > 0)
			return parentIds;

		try
		{
			return Load(
				compositionLoadService, session,
				(int)contact.ObjectID, contact.ObjectType, null, false);
		}
		catch
		{
			return parentIds;
		}
	}

	private static List<int> Load(
		ICompositionLoadService compositionLoadService,
		IUserSession scriptSession,
		int objId,
		int objTypeId,
		List<int> searchRelationTypes,
		bool composition)
	{
		List<int> idList = new List<int>();
		if (compositionLoadService == null)
			return idList;

		DataTable table = compositionLoadService.LoadComposition(
			scriptSession,
			objId,
			objTypeId,
			searchRelationTypes,
			null,
			new List<ColumnDescriptor>
			{
				new ColumnDescriptor(
					(int)ObligatoryObjectAttributes.F_OBJECT_ID,
					AttributeSourceTypes.Object,
					ColumnContents.Text,
					ColumnNameMapping.FieldName,
					SortOrders.NONE,
					0)
			},
			composition,
			false,
			null,
			new ConditionStructure[] { },
			SystemGUIDs.filtrationAllVersions,
			null,
			-1);

		if (table == null)
			return idList;

		foreach (DataRow row in table.Rows)
		{
			int id;
			if (int.TryParse(row[Consts.F_OBJECT_ID].ToString(), out id))
				idList.Add(id);
		}

		return idList;
	}

	// =======================================================================
	// ОБСУЖДЕНИЕ
	// =======================================================================

	private static void SendMessage(IUserSession scriptSession, long objectID, string caption, string messageText)
	{
		IForumsService forumService = scriptSession.GetCustomService(typeof(IForumsService)) as IForumsService;
		if (forumService == null) throw new Exception("Служба обсуждений (IForumsService) не найдена");

		IFiltrationService fSvc = ServicesManager.GetService(typeof(IFiltrationService)) as IFiltrationService;
		if (fSvc == null) throw new Exception("Служба фильтрации (IFiltrationService) не найдена");

		ICurrentUserAndRole cc = ServicesManager.GetService(typeof(ICurrentUserAndRole)) as ICurrentUserAndRole;
		if (cc == null) throw new Exception("Служба текущего пользователя (ICurrentUserAndRole) не найдена");

		IDBObject obj = scriptSession.GetObject(objectID);
		if (obj == null) throw new Exception("Объект с ID=" + objectID + " не найден");

		var forum = forumService.GenerationForum(
			objectID, obj.ID, ForumFormat.Version, fSvc.FiltrationServiceOwnerID, scriptSession.SessionGUID);

		UserMessage message = new UserMessage
		{
			Caption = caption,
			Date = DateTime.UtcNow,
			Message = messageText,
			UserGuid = cc.UserGuid.ToString(),
			DiscussedObjectGuid = obj.GUID.ToString()
		};

		message.ReadByUsers.Add(cc.UserGuid.ToString());

		forumService.AddMessageToDiscussion(message, objectID, obj.ID, forum, scriptSession.SessionGUID);
	}

	// =======================================================================
	// ЭМУЛЯЦИЯ ЗВОНКА
	// =======================================================================

	private static void PressCtrlShiftE()
	{
		keybd_event(0x11, 0, 0, 0); // Ctrl down
		keybd_event(0x10, 0, 0, 0); // Shift down
		keybd_event(0x45, 0, 0, 0); // E down
		keybd_event(0x45, 0, 2, 0); // E up
		keybd_event(0x10, 0, 2, 0); // Shift up
		keybd_event(0x11, 0, 2, 0); // Ctrl up
	}

	[DllImport("user32.dll", SetLastError = true)]
	private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);

	private string ReadClipboard()
	{
		try
		{
			return Clipboard.ContainsText() ? Clipboard.GetText() : null;
		}
		catch
		{
			return null;
		}
	}

	// =======================================================================
	// ДИАЛОГ РЕЗУЛЬТАТА ЗВОНКА
	// =======================================================================

	private InputResult ShowCallResultDialog()
	{
		using (Form form = new Form())
		{
			Label labelDate = new Label();
			DateTimePicker datePicker = new DateTimePicker();
			Label labelComment = new Label();
			TextBox textBox = new TextBox();
			Button buttonNoAnswer = new Button();
			Button buttonOk = new Button();
			Button buttonCancel = new Button();

			form.Text = "Результат звонка";
			form.ClientSize = new Size(400, 270);
			form.FormBorderStyle = FormBorderStyle.FixedDialog;
			form.StartPosition = FormStartPosition.CenterScreen;
			form.MaximizeBox = false;
			form.MinimizeBox = false;

			labelDate.Text = "Дата следующего контакта:";
			labelDate.SetBounds(12, 12, 200, 15);

			datePicker.SetBounds(12, 30, 200, 20);
			datePicker.Format = DateTimePickerFormat.Short;

			labelComment.Text = "Комментарий:";
			labelComment.SetBounds(12, 60, 200, 15);

			textBox.SetBounds(12, 78, 376, 140);
			textBox.Multiline = true;
			textBox.ScrollBars = ScrollBars.Vertical;

			buttonNoAnswer.Text = NoAnswerText;
			buttonNoAnswer.SetBounds(12, 230, 110, 25);
			buttonNoAnswer.Click += delegate
			{
				textBox.Text = NoAnswerText;
				form.DialogResult = DialogResult.OK;
			};

			buttonOk.Text = "ОК";
			buttonOk.DialogResult = DialogResult.OK;
			buttonOk.SetBounds(228, 230, 75, 25);

			buttonCancel.Text = "Отмена";
			buttonCancel.DialogResult = DialogResult.Cancel;
			buttonCancel.SetBounds(313, 230, 75, 25);

			form.Controls.AddRange(new Control[]
				{ labelDate, datePicker, labelComment, textBox, buttonNoAnswer, buttonOk, buttonCancel });

			form.AcceptButton = buttonOk;
			form.CancelButton = buttonCancel;

			if (form.ShowDialog() != DialogResult.OK)
				return null;

			return new InputResult
			{
				Comment = textBox.Text,
				SelectedDate = datePicker.Value
			};
		}
	}

	// =======================================================================
	// СООБЩЕНИЯ
	// =======================================================================

	private void Show(string text, MessageBoxIcon icon)
	{
		MessageBox.Show(text, DialogCaption, MessageBoxButtons.OK, icon);
	}

	// Итог: что записано в карточку предприятия и что не удалось.
	private void ShowResult(bool lastSaved, bool nextSaved, DateTime lastContact, DateTime nextContact,
		List<string> problems)
	{
		StringBuilder text = new StringBuilder();

		if (lastSaved)
			text.Append("Дата последнего контакта: " + lastContact.ToString("dd.MM.yyyy HH:mm"));

		if (nextSaved)
		{
			if (text.Length > 0)
				text.Append(Environment.NewLine);

			text.Append("Дата следующего контакта: " + nextContact.ToString("dd.MM.yyyy"));
		}

		if (text.Length == 0)
			text.Append("Даты в карточке предприятия не обновлены.");

		if (problems.Count == 0)
		{
			Show(text.ToString(), MessageBoxIcon.Information);
			return;
		}

		text.Append(Environment.NewLine + Environment.NewLine + "Замечания:");
		foreach (string problem in problems)
			text.Append(Environment.NewLine + "- " + problem);

		Show(text.ToString(), MessageBoxIcon.Warning);
	}
}
