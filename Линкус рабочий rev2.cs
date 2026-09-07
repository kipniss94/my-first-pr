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
// Звонок контакту на РАБОЧИЙ телефон через Linkus и регистрация результата.
//
// Скрипт вызывается с карточки контакта и:
//   1) копирует рабочий телефон («Тел.1») в буфер обмена и эмулирует
//      Ctrl+Shift+E (звонок);
//   2) показывает немодальное окно результата: дата следующего контакта
//      и комментарий. Окно не блокирует IPS — его можно свернуть,
//      поработать в системе и вернуться к записи позже;
//   3) по «ОК» у родительского объекта (предприятия) обновляет «Дату
//      последнего контакта» и «Дату следующего контакта»;
//   4) пишет результат разговора в обсуждение предприятия;
//   5) если отмечена галочка «Поставить задачу органайзера», ставит задачу
//      на дату следующего контакта — то же, что кнопка на карточке
//      предприятия.
//
// Запись выполняется уже после завершения скрипта (окно немодальное),
// поэтому вся работа с базой в CompleteCall идёт внутри SessionKeeper —
// вне него объекты сервера приложений использовать нельзя.
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
	private readonly Guid AttrPhoneGuid = new Guid("c4b636db-0dc8-467c-a02c-a25c5d03dd86");        // Телефон раб. (Тел.1)
	private readonly Guid AttrDesignationGuid = new Guid("cad0001f-306c-11d8-b4e9-00304f19f545");  // Обозначение
	private readonly Guid AttrLastContactGuid = new Guid("70448372-c797-4a51-b923-a810436107b5");  // Дата последнего контакта
	private readonly Guid AttrNextContactGuid = new Guid("50676414-494a-498d-bae1-4e1af2b7e172");  // Дата следующего контакта
	private readonly Guid RelationSimpleGuid = new Guid("cad00023-306c-11d8-b4e9-00304f19f545");   // Простая связь между объектами

	private readonly Guid AttrNameGuid = new Guid("cad00020-306c-11d8-b4e9-00304f19f545");         // Наименование

	private const string AttrLastContactName = "Дата последнего контакта";
	private const string AttrNextContactName = "Дата следующего контакта";

	// --- задача органайзера (та же логика, что у кнопки на карточке предприятия) ---
	private const string TaskTypeName = "Задачи органайзера";
	private const string TaskResourceRelationName = "Связь задачи органайзера с ресурсами";

	private const string AttrCaptionName = "Наименование";
	private const string AttrTaskStartName = "Начато";
	private const string AttrTaskDeadlineName = "Срок выполнения";
	private const string AttrTaskTextName = "Текст задачи органайзера";
	private const string AttrReminderName = "Напоминание о задаче органайзера";
	private const string AttrRemindBeforeName = "Напомнить за (интервал)";
	private const string AttrShowPopupName = "Показывать напоминание во всплывающем окне";

	private const string RemindBeforeText = "за 15 мин.";
	private const string ObjectLinkPrefix = "ips://object/";

	private const int TaskStartHour = 9;          // задача ставится на 09:00 даты контакта
	private const int TaskDurationMinutes = 10;   // срок выполнения = начало + 10 минут
	private const int MaxRelationTypeID = 10000;  // верхняя граница перебора типов связей

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
		public bool CreateTask { get; set; }
	}

	// Данные, нужные для записи результата после закрытия окна
	private class CallContext
	{
		// Сессия здесь не хранится: к моменту записи скрипт уже завершён,
		// и работать с базой можно только через новый SessionKeeper.
		public int ParentId;
		public string ContactGuid;
		public string ContactTitle;
		public List<string> Problems;
	}

	public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
	{
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
				Show("Атрибут «Телефон раб.» не заполнен — звонок невозможен.", MessageBoxIcon.Warning);
				return parameters;
			}

			string contactTitle = GetAttributeText(contact, AttrDesignationGuid);
			if (string.IsNullOrEmpty(contactTitle))
				contactTitle = contact.Caption ?? "Без названия";

			// Замечания, не мешающие выполнить звонок: показываются в итоговом сообщении
			List<string> problems = new List<string>();

			// ==================================================
			// 2. ЗВОНОК (Linkus вызывается сочетанием Ctrl+Shift+E)
			// ==================================================
			MakeCall(phoneValue, problems);

			// ==================================================
			// 3. ПРЕДПРИЯТИЕ
			// Ищется до показа окна результата, чтобы о проблемах было известно
			// сразу, а не после ввода комментария.
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

			// ==================================================
			// 4. ОКНО РЕЗУЛЬТАТА ЗВОНКА
			// Окно немодальное: IPS остаётся доступным, окно можно свернуть,
			// поработать в системе и вернуться к нему позже. Даты и запись
			// в обсуждение выполняются по нажатию «ОК» — уже после того,
			// как скрипт завершится (CompleteCall).
			// ==================================================
			CallContext context = new CallContext();
			context.ParentId = parentIds[0];
			context.ContactGuid = contact.ObjectGUID.ToString();
			context.ContactTitle = contactTitle;
			context.Problems = problems;

			ShowCallResultDialog(context);
		}
		catch (Exception ex)
		{
			Show("Ошибка: " + ex.Message, MessageBoxIcon.Error);
		}

		return parameters;
	}

	// Звонок: номер кладётся в буфер обмена, Linkus вызывается сочетанием
	// клавиш, после чего в буфер возвращается прежнее содержимое.
	private void MakeCall(string phoneValue, List<string> problems)
	{
		string savedClipboard = ReadClipboard();

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
		finally
		{
			if (savedClipboard != null)
			{
				try { Clipboard.SetText(savedClipboard); }
				catch { }
			}
		}
	}

	// Запись результата звонка: даты у предприятия и сообщение в обсуждение.
	// Вызывается из окна результата, поэтому предприятие читается заново —
	// между звонком и вводом комментария пользователь мог работать в IPS.
	private void CompleteCall(CallContext context, InputResult result)
	{
		DateTime lastContact = DateTime.Now;
		DateTime nextContact = result.SelectedDate.Date;

		bool lastSaved = false;
		bool nextSaved = false;
		string taskLine = null;

		// Перебранные способы добавления атрибута: попадают в сообщение,
		// если добавить атрибут так и не удалось.
		List<string> diagnostics = new List<string>();

		try
		{
			// Скрипт к этому моменту уже завершён, а объекты сервера приложений
			// вне SessionKeeper использовать нельзя — поэтому сессия открывается
			// заново, и вся работа с базой идёт через неё.
			using (SessionKeeper keeper = new SessionKeeper())
			{
				IUserSession session = keeper.Session;

				IDBObject parentObj = session.GetObject(context.ParentId);
				if (parentObj == null)
				{
					Show("Не удалось получить предприятие (идентификатор " + context.ParentId + ").",
						MessageBoxIcon.Error);
					return;
				}

				lastSaved = SetDateValue(session, parentObj, AttrLastContactGuid, AttrLastContactName,
					lastContact, context.Problems, diagnostics);
				nextSaved = SetDateValue(session, parentObj, AttrNextContactGuid, AttrNextContactName,
					nextContact, context.Problems, diagnostics);

				try
				{
					StringBuilder text = new StringBuilder();
					text.Append("Результат общения с [ref=\"" + context.ContactGuid + "\"]" + context.ContactTitle + "[/ref]: ");
					text.Append(Environment.NewLine);
					text.Append(result.Comment == null ? string.Empty : result.Comment.Trim());

					SendMessage(session, context.ParentId, ForumTopic, text.ToString());
				}
				catch (Exception forumEx)
				{
					context.Problems.Add("запись в обсуждение: " + forumEx.Message);
				}

				// Задача органайзера — если отмечена галочка в окне результата
				if (result.CreateTask)
					taskLine = CreateOrganizerTask(session, parentObj, nextContact, context.Problems);
			}
		}
		catch (Exception ex)
		{
			Show("Ошибка при записи результата звонка: " + ex.Message, MessageBoxIcon.Error);
			return;
		}

		// Сообщение показывается после закрытия сессии, чтобы не держать её
		// открытой на время диалога.
		ShowResult(lastSaved, nextSaved, lastContact, nextContact, taskLine, context.Problems, diagnostics);
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
		string attributeName, DateTime value, List<string> problems, List<string> diagnostics)
	{
		IDBAttribute attribute = EnsureAttribute(session, obj, attributeGuid, attributeName, value, diagnostics);
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
	// Атрибуты «Дата последнего/следующего контакта» имеют признак «Атрибут
	// может быть добавлен вручную»: пока значение не заполнено, объекту они
	// не присвоены и GetAttributeByGuid возвращает null (раньше запись в этом
	// случае молча пропускалась). Здесь атрибут сначала добавляется объекту.
	// Метод добавления в разных версиях API называется по-разному, поэтому
	// подходящий подбирается по сигнатуре; перебранные варианты складываются
	// в diagnostics и попадают в сообщение, если ни один не сработал.
	private IDBAttribute EnsureAttribute(IUserSession session, IDBObject obj, Guid attributeGuid,
		string attributeName, object value, List<string> diagnostics)
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
			// идентификатор атрибута определить не удалось — пробуем по GUID и имени
		}

		// 1) перегрузки чтения атрибута с признаком «создать, если нет»
		attribute = TryCalls(obj, obj, attributeGuid, attributeID, attributeName, value,
			new string[] { "GetAttribute" }, diagnostics);
		if (attribute != null)
			return attribute;

		// 2) методы добавления у коллекции атрибутов объекта
		attribute = TryCalls(obj, obj.Attributes, attributeGuid, attributeID, attributeName, value,
			new string[] { "Add", "Create", "Insert", "New" }, diagnostics);
		if (attribute != null)
			return attribute;

		// 3) методы добавления у самого объекта
		attribute = TryCalls(obj, obj, attributeGuid, attributeID, attributeName, value,
			new string[] { "AddAttribute", "CreateAttribute", "AddObjectAttribute" }, diagnostics);
		if (attribute != null)
			return attribute;

		// 4) методы добавления у пользовательской сессии
		return TryCalls(obj, session, attributeGuid, attributeID, attributeName, value,
			new string[] { "AddObjectAttribute", "SetObjectAttributeValue", "SetObjectAttributesValues" },
			diagnostics);
	}

	// Перебор методов заданного объекта: аргументы подбираются по типам
	// параметров, после каждого вызова проверяется, появился ли атрибут.
	private IDBAttribute TryCalls(IDBObject obj, object target, Guid attributeGuid, int attributeID,
		string attributeName, object value, string[] methodNames, List<string> diagnostics)
	{
		if (target == null)
			return null;

		foreach (MethodInfo method in target.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance))
		{
			if (!NameStartsWithAny(method.Name, methodNames))
				continue;

			ParameterInfo[] methodParameters = method.GetParameters();
			object[] arguments = new object[methodParameters.Length];
			bool suitable = true;

			for (int i = 0; i < methodParameters.Length; i++)
			{
				Type parameterType = methodParameters[i].ParameterType;

				if (parameterType == typeof(int))
					arguments[i] = attributeID;
				else if (parameterType == typeof(long))
					arguments[i] = obj.ObjectID;
				else if (parameterType == typeof(Guid))
					arguments[i] = attributeGuid;
				else if (parameterType == typeof(string))
					arguments[i] = attributeName;
				else if (parameterType == typeof(bool))
					arguments[i] = true;
				else if (parameterType == typeof(object) || parameterType == typeof(DateTime))
					arguments[i] = value;
				else
				{
					suitable = false; // тип параметра подобрать нельзя — метод пропускаем
					break;
				}
			}

			if (!suitable)
				continue;

			// пропускаем заведомо бесполезный вариант: чтение атрибута без признака создания
			if (methodParameters.Length == 1 && method.Name.StartsWith("GetAttribute", StringComparison.Ordinal))
				continue;

			diagnostics.Add(target.GetType().Name + "." + method.Name + "(" + DescribeParameters(methodParameters) + ")");

			object result;
			try
			{
				result = method.Invoke(target, arguments);
			}
			catch
			{
				continue; // сигнатура не подошла — пробуем следующий метод
			}

			IDBAttribute returned = result as IDBAttribute;
			if (returned != null)
				return returned;

			IDBAttribute found = obj.GetAttributeByGuid(attributeGuid);
			if (found != null)
				return found;
		}

		return null;
	}

	private bool NameStartsWithAny(string methodName, string[] prefixes)
	{
		foreach (string prefix in prefixes)
		{
			if (methodName.StartsWith(prefix, StringComparison.Ordinal))
				return true;
		}

		return false;
	}

	private string DescribeParameters(ParameterInfo[] methodParameters)
	{
		StringBuilder text = new StringBuilder();

		foreach (ParameterInfo parameter in methodParameters)
		{
			if (text.Length > 0)
				text.Append(", ");

			text.Append(parameter.ParameterType.Name);
		}

		return text.ToString();
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

	// Немодальное окно результата звонка: пока оно открыто, с IPS можно
	// работать, окно сворачивается и доступно с панели задач. По «ОК»
	// (или «Не дозвонился») вызывается CompleteCall — запись дат и сообщения
	// в обсуждение; по «Отмена» ничего не записывается.
	private void ShowCallResultDialog(CallContext context)
	{
		Form form = new Form();
		Label labelDate = new Label();
		DateTimePicker datePicker = new DateTimePicker();
		CheckBox checkTask = new CheckBox();
		Label labelComment = new Label();
		TextBox textBox = new TextBox();
		Button buttonNoAnswer = new Button();
		Button buttonOk = new Button();
		Button buttonCancel = new Button();

		form.Text = "Результат звонка — " + context.ContactTitle;
		form.ClientSize = new Size(400, 270);
		form.MinimumSize = new Size(360, 260);
		form.FormBorderStyle = FormBorderStyle.Sizable;
		form.StartPosition = FormStartPosition.CenterScreen;
		form.MinimizeBox = true;    // окно можно свернуть и вернуться к нему позже
		form.MaximizeBox = false;
		form.ShowInTaskbar = true;  // и найти его на панели задач

		labelDate.Text = "Дата следующего контакта:";
		labelDate.SetBounds(12, 12, 200, 15);

		datePicker.SetBounds(12, 30, 130, 20);
		datePicker.Format = DateTimePickerFormat.Short;

		// То же, что кнопка «Задача органайзера» на карточке предприятия:
		// задача ставится на выбранную дату при нажатии «ОК».
		checkTask.Text = "Поставить задачу органайзера";
		checkTask.SetBounds(150, 31, 240, 20);
		checkTask.Checked = true;

		labelComment.Text = "Комментарий:";
		labelComment.SetBounds(12, 60, 200, 15);

		textBox.SetBounds(12, 78, 376, 140);
		textBox.Multiline = true;
		textBox.ScrollBars = ScrollBars.Vertical;
		textBox.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;

		buttonNoAnswer.Text = NoAnswerText;
		buttonNoAnswer.SetBounds(12, 230, 110, 25);
		buttonNoAnswer.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;

		buttonOk.Text = "ОК";
		buttonOk.SetBounds(228, 230, 75, 25);
		buttonOk.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;

		buttonCancel.Text = "Отмена";
		buttonCancel.SetBounds(313, 230, 75, 25);
		buttonCancel.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;

		// Окно закрывается раньше записи результата, чтобы итоговое сообщение
		// не перекрывалось им.
		buttonOk.Click += delegate
		{
			InputResult result = new InputResult();
			result.Comment = textBox.Text;
			result.SelectedDate = datePicker.Value;
			result.CreateTask = checkTask.Checked;

			form.Close();
			CompleteCall(context, result);
		};

		buttonNoAnswer.Click += delegate
		{
			InputResult result = new InputResult();
			result.Comment = NoAnswerText;
			result.SelectedDate = datePicker.Value;
			result.CreateTask = checkTask.Checked;

			form.Close();
			CompleteCall(context, result);
		};

		buttonCancel.Click += delegate
		{
			form.Close();
		};

		form.FormClosed += delegate
		{
			form.Dispose();
		};

		form.Controls.AddRange(new Control[]
			{ labelDate, datePicker, checkTask, labelComment, textBox, buttonNoAnswer, buttonOk, buttonCancel });

		form.AcceptButton = buttonOk;
		form.CancelButton = buttonCancel;

		form.Show();
	}

	// =======================================================================
	// ЗАДАЧА ОРГАНАЙЗЕРА
	// =======================================================================

	// Постановка задачи органайзера на дату следующего контакта — то же, что
	// делает кнопка на карточке предприятия. Вызывается внутри SessionKeeper,
	// сессия передаётся аргументом. Возвращает строку для итогового сообщения
	// или null, если задача не создана.
	private string CreateOrganizerTask(IUserSession session, IDBObject enterprise, DateTime nextContact,
		List<string> problems)
	{
		try
		{
			int taskTypeID = MetaDataHelper.GetObjectTypeIDFromName(TaskTypeName);
			IDBObjectCollection taskCollection = session.GetObjectCollection(taskTypeID);

			IDBObject task = taskCollection.Create();
			if (task == null)
			{
				problems.Add("не удалось создать объект типа «" + TaskTypeName + "»");
				return null;
			}

			DateTime taskStart = nextContact.Date.AddHours(TaskStartHour);
			DateTime taskDeadline = taskStart.AddMinutes(TaskDurationMinutes);

			string enterpriseName = GetAttributeText(enterprise, AttrNameGuid);
			if (string.IsNullOrEmpty(enterpriseName))
				enterpriseName = enterprise.Caption ?? string.Empty;

			SetTaskValue(task, AttrTaskStartName, problems, taskStart);
			SetTaskValue(task, AttrTaskDeadlineName, problems, taskDeadline);
			SetTaskValue(task, AttrCaptionName, problems, "Связаться с " + enterpriseName);

			// Текст задачи: наименование предприятия и ссылка на его карточку
			SetTaskValue(task, AttrTaskTextName, problems,
				"Связаться с " + enterpriseName + " " + ObjectLinkPrefix + enterprise.ObjectID);

			if (task.IsCreationMode)
				task.CommitCreation(true);

			AddTaskResource(session, task, problems);

			return "Задача органайзера: " + taskStart.ToString("dd.MM.yyyy HH:mm");
		}
		catch (Exception ex)
		{
			problems.Add("задача органайзера: " + ex.Message);
			return null;
		}
	}

	// Текущий пользователь IPS включается в состав задачи связью
	// «Связь задачи органайзера с ресурсами» с атрибутами напоминания.
	private void AddTaskResource(IUserSession session, IDBObject task, List<string> problems)
	{
		long currentUserID = GetCurrentUserObjectID(session);
		if (currentUserID <= 0)
		{
			problems.Add("задача создана, но текущего пользователя определить не удалось — напоминание не назначено");
			return;
		}

		int relationTypeID = ResolveRelationTypeIDByName(TaskResourceRelationName);
		if (relationTypeID <= 0)
		{
			problems.Add("задача создана, но тип связи «" + TaskResourceRelationName + "» не найден");
			return;
		}

		IDBRelationCollection relations = session.GetRelationCollection(relationTypeID);
		IDBRelation relation = relations.Create(task.ObjectID, currentUserID);

		if (relation == null)
		{
			problems.Add("задача создана, но связь с пользователем не создана");
			return;
		}

		SetRelationValue(relation, AttrReminderName, problems, true, 1, "Да");
		SetRelationValue(relation, AttrShowPopupName, problems, true, 1, "Да");

		// «Напомнить за (интервал)» — строка из списка допустимых значений.
		// IPS подставляет это же значение по умолчанию, а запись из скрипта
		// отклоняет проверкой списка, поэтому замечания здесь не собираются.
		SetRelationValue(relation, AttrRemindBeforeName, null, RemindBeforeText);
	}

	// Идентификатор типа связи по наименованию: поиска по имени в MetaDataHelper
	// нет, поэтому используется обратное преобразование GetRelationTypeName(id).
	private int ResolveRelationTypeIDByName(string relationName)
	{
		for (int relationTypeID = 1; relationTypeID <= MaxRelationTypeID; relationTypeID++)
		{
			string name;
			try
			{
				name = MetaDataHelper.GetRelationTypeName(relationTypeID);
			}
			catch
			{
				continue; // типа связи с таким идентификатором нет
			}

			if (!string.IsNullOrEmpty(name) &&
				string.Compare(name.Trim(), relationName, StringComparison.CurrentCultureIgnoreCase) == 0)
			{
				return relationTypeID;
			}
		}

		return -1;
	}

	// Присвоение значения атрибуту задачи по наименованию атрибута
	private void SetTaskValue(IDBObject obj, string attributeName, List<string> problems, params object[] values)
	{
		AssignFirst(obj.Attributes.FindByName(attributeName), attributeName, problems, values);
	}

	// Присвоение значения атрибуту связи
	private void SetRelationValue(IDBRelation relation, string attributeName, List<string> problems,
		params object[] values)
	{
		AssignFirst(relation.Attributes.FindByName(attributeName), attributeName, problems, values);
	}

	// Записывает первое из значений, которое принимает тип атрибута.
	// problems может быть null — тогда неудача не считается замечанием.
	private void AssignFirst(IDBAttribute attribute, string attributeName, List<string> problems, object[] values)
	{
		if (attribute == null)
		{
			if (problems != null)
				problems.Add("атрибут «" + attributeName + "» не найден");

			return;
		}

		string currentValue = null;
		try
		{
			if (attribute.Value != null)
				currentValue = attribute.Value.ToString().Trim();
		}
		catch
		{
			// значение недоступно для чтения — считаем его неизвестным
		}

		foreach (object value in values)
		{
			if (value == null)
				continue;

			// нужное значение уже записано (например, значением по умолчанию)
			if (currentValue != null &&
				string.Compare(currentValue, value.ToString().Trim(), StringComparison.CurrentCultureIgnoreCase) == 0)
			{
				return;
			}

			try
			{
				attribute.Value = value;
				return;
			}
			catch
			{
				// тип атрибута не принимает такое значение — пробуем следующее
			}
		}

		if (problems != null)
			problems.Add("не удалось записать значение в атрибут «" + attributeName + "»");
	}

	// =======================================================================
	// ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ
	// =======================================================================

	// Идентификатор объекта пользователя, под которым выполнен вход в IPS.
	// Свойство с идентификатором в разных версиях API называется по-разному,
	// поэтому источники перебираются по очереди.
	private long GetCurrentUserObjectID(IUserSession session)
	{
		ICurrentUserAndRole currentUser =
			ServicesManager.GetService(typeof(ICurrentUserAndRole)) as ICurrentUserAndRole;

		long userID = ReadIdentifier(currentUser, "UserID", "UserId", "CurrentUserID", "ID");
		if (userID > 0)
			return userID;

		userID = ReadIdentifier(session, "UserID", "UserId", "CurrentUserID");
		if (userID > 0)
			return userID;

		if (currentUser != null)
		{
			IDBObject userObject = FindObjectByGuid(session, currentUser.UserGuid.ToString());
			if (userObject != null)
				return userObject.ObjectID;
		}

		return -1;
	}

	// Чтение целочисленного идентификатора из первого подходящего свойства (поля).
	private long ReadIdentifier(object source, params string[] memberNames)
	{
		if (source == null)
			return -1;

		List<Type> types = new List<Type>();
		types.Add(source.GetType());
		types.AddRange(source.GetType().GetInterfaces());

		BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy;

		foreach (string memberName in memberNames)
		{
			foreach (Type type in types)
			{
				try
				{
					object value = null;

					PropertyInfo property = type.GetProperty(memberName, flags);
					if (property != null && property.CanRead)
					{
						value = property.GetValue(source, null);
					}
					else
					{
						FieldInfo field = type.GetField(memberName, flags);
						if (field != null)
							value = field.GetValue(source);
					}

					if (value == null)
						continue;

					long identifier = Convert.ToInt64(value);
					if (identifier > 0)
						return identifier;
				}
				catch
				{
					// свойство недоступно или значение не приводится к числу — идём дальше
				}
			}
		}

		return -1;
	}

	// Поиск объекта по глобальному идентификатору (запасной путь получения
	// объекта пользователя).
	private IDBObject FindObjectByGuid(IUserSession session, string guidText)
	{
		Guid guid;
		try
		{
			guid = new Guid(guidText);
		}
		catch
		{
			return null;
		}

		string[] methodNames = new string[] { "GetObjectByGUID", "GetObjectByGuid", "GetObject" };

		foreach (string methodName in methodNames)
		{
			MethodInfo method = session.GetType().GetMethod(methodName, new Type[] { typeof(Guid) });
			if (method == null)
				continue;

			try
			{
				IDBObject found = method.Invoke(session, new object[] { guid }) as IDBObject;
				if (found != null)
					return found;
			}
			catch
			{
				// метод есть, но вызов не удался — пробуем следующий вариант
			}
		}

		return null;
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
		string taskLine, List<string> problems, List<string> diagnostics)
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

		if (!string.IsNullOrEmpty(taskLine))
		{
			if (text.Length > 0)
				text.Append(Environment.NewLine);

			text.Append(taskLine);
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

		// Если атрибут не удалось добавить, показываем перебранные методы API:
		// по ним видно, какой вызов нужно прописать в скрипте явно.
		if (!lastSaved && !nextSaved && diagnostics.Count > 0)
		{
			text.Append(Environment.NewLine + Environment.NewLine + "Опробованные методы API:");

			List<string> shown = new List<string>();
			foreach (string item in diagnostics)
			{
				if (shown.Contains(item))
					continue;

				shown.Add(item);
				text.Append(Environment.NewLine + "- " + item);
			}
		}

		Show(text.ToString(), MessageBoxIcon.Warning);
	}
}
