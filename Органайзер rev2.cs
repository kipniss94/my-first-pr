using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Intermech;
using Intermech.Client.Core;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;

// ===========================================================================
// Создание задачи органайзера с карточки предприятия.
//
// Скрипт вызывается с карточки объекта-источника (предприятия) и:
//   1) читает атрибуты «Дата следующего контакта» и «Наименование»;
//   2) создаёт объект типа «Задачи органайзера» и заполняет:
//        «Начато»                   = дата следующего контакта, 09:00;
//        «Срок выполнения»          = «Начато» + 10 мин;
//        «Наименование»             = «Связаться с <наименование предприятия>»;
//        «Текст задачи органайзера» = «Связаться с ips://object/<ид. версии>»;
//   3) включает текущего пользователя IPS в состав задачи связью
//      «Связь задачи органайзера с ресурсами» и заполняет атрибуты связи:
//        «Напоминание о задаче органайзера» = да;
//        «Напомнить за (интервал)»          = 15 мин.
//
// Все наименования типов, связей и атрибутов вынесены в константы в начале
// класса — при отличиях в конкретной базе правятся только они.
// ===========================================================================
public class Script
{
	public ICSharpScriptContext ScriptContext { get; private set; }

	// --- наименования типов, связей и атрибутов ---
	private const string TaskTypeName = "Задачи органайзера";
	private const string TaskResourceRelationName = "Связь задачи органайзера с ресурсами";

	private const string AttrNextContactDateName = "Дата следующего контакта";
	private const string AttrCaptionName = "Наименование";
	private const string AttrTaskStartName = "Начато";
	private const string AttrTaskDeadlineName = "Срок выполнения";
	private const string AttrTaskTextName = "Текст задачи органайзера";
	private const string AttrReminderName = "Напоминание о задаче органайзера";
	private const string AttrRemindBeforeName = "Напомнить за (интервал)";

	// --- параметры формируемой задачи ---
	private const int TaskStartHour = 9;         // задача ставится на 09:00 даты контакта
	private const int TaskDurationMinutes = 10;  // срок выполнения = начало + 10 минут
	private const int RemindBeforeMinutes = 15;  // напомнить за 15 минут до начала

	private const string DialogCaption = "Задача органайзера";
	private const string ObjectLinkPrefix = "ips://object/";

	public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
	{
		// Замечания, не мешающие создать задачу: показываются одним сообщением в конце.
		List<string> warnings = new List<string>();

		try
		{
			// пользовательская сессия
			IUserSession session = parameters.UserSession;

			// ---------------------------------------------------------------
			// 1. Объект-источник — предприятие, с карточки которого вызван скрипт
			// ---------------------------------------------------------------
			IDBObject source = session.GetObject(parameters.ObjectID);
			if (source == null)
			{
				Show("Не удалось получить объект, с карточки которого вызван скрипт.", MessageBoxIcon.Error);
				return parameters;
			}

			// Атрибут может отсутствовать у типа объекта либо быть незаполненным —
			// проверяются оба случая (в прежней версии проверялось только наличие).
			IDBAttribute attrNextContact = source.GetAttributeByName(AttrNextContactDateName);
			if (attrNextContact == null || attrNextContact.Value == null)
			{
				Show("Не заполнен атрибут «" + AttrNextContactDateName + "».", MessageBoxIcon.Warning);
				return parameters;
			}

			DateTime nextContactDate;
			try
			{
				// Значение атрибута даты преобразуется напрямую, без промежуточной
				// строки: разбор строки зависел от региональных настроек клиента.
				nextContactDate = Convert.ToDateTime(attrNextContact.Value);
			}
			catch
			{
				Show("Значение атрибута «" + AttrNextContactDateName + "» не является датой: " +
					attrNextContact.Value, MessageBoxIcon.Warning);
				return parameters;
			}

			// Время в атрибуте не учитывается: задача всегда ставится на 09:00 указанного дня.
			DateTime taskStart = nextContactDate.Date.AddHours(TaskStartHour);
			DateTime taskDeadline = taskStart.AddMinutes(TaskDurationMinutes);

			string sourceName = GetAttributeText(source, AttrCaptionName);
			if (string.IsNullOrEmpty(sourceName))
				sourceName = source.Caption ?? string.Empty; // страховка: описатель объекта

			// ---------------------------------------------------------------
			// 2. Объект-получатель — задача органайзера
			// ---------------------------------------------------------------
			int taskTypeID = MetaDataHelper.GetObjectTypeIDFromName(TaskTypeName);
			IDBObjectCollection taskCollection = session.GetObjectCollection(taskTypeID);

			IDBObject task = taskCollection.Create();
			if (task == null)
			{
				Show("Не удалось создать объект типа «" + TaskTypeName + "».", MessageBoxIcon.Error);
				return parameters;
			}

			SetValue(task, AttrTaskStartName, warnings, taskStart);
			SetValue(task, AttrTaskDeadlineName, warnings, taskDeadline);
			SetValue(task, AttrCaptionName, warnings, "Связаться с " + sourceName);

			// «Текст задачи органайзера» — ссылка на предприятие вида
			// ips://object/<идентификатор версии объекта-источника>.
			SetValue(task, AttrTaskTextName, warnings, "Связаться с " + ObjectLinkPrefix + source.ObjectID);

			// Завершаем создание объекта
			if (task.IsCreationMode)
			{
				try
				{
					task.CommitCreation(true);
				}
				catch (ObjectAlreadyExists)
				{
					Show("Задача органайзера с таким наименованием уже существует.", MessageBoxIcon.Warning);
					return parameters;
				}
			}

			// ---------------------------------------------------------------
			// 3. Текущий пользователь IPS — в состав задачи по связи
			//    «Связь задачи органайзера с ресурсами»
			// ---------------------------------------------------------------
			long currentUserID = GetCurrentUserObjectID(session);
			if (currentUserID <= 0)
			{
				warnings.Add("не удалось определить текущего пользователя IPS — связь с ресурсом не создана");
			}
			else
			{
				int relationTypeID = MetaDataHelper.GetRelationTypeIDFromName(TaskResourceRelationName);
				IDBRelationCollection relations = session.GetRelationCollection(relationTypeID);

				// Аргументы Create: 1 — ид. версии задачи, 2 — ид. версии пользователя
				IDBRelation taskUserRelation = relations.Create(task.ObjectID, currentUserID);
				if (taskUserRelation == null)
				{
					warnings.Add("не удалось создать связь «" + TaskResourceRelationName + "»");
				}
				else
				{
					// Тип атрибутов связи зависит от настройки базы, поэтому значение
					// подбирается перебором: первое подошедшее записывается.
					SetValue(taskUserRelation, AttrReminderName, warnings, true, 1, "Да");
					SetValue(taskUserRelation, AttrRemindBeforeName, warnings,
						RemindBeforeMinutes + " мин.",
						RemindBeforeMinutes,
						TimeSpan.FromMinutes(RemindBeforeMinutes),
						"за " + RemindBeforeMinutes + " мин.");
				}
			}

			if (warnings.Count > 0)
			{
				StringBuilder text = new StringBuilder("Задача органайзера создана, но заполнены не все данные:");
				foreach (string warning in warnings)
					text.Append(Environment.NewLine + "- " + warning);

				Show(text.ToString(), MessageBoxIcon.Warning);
			}
		}
		catch (Exception ex)
		{
			Show("Ошибка при создании задачи органайзера: " + ex.Message, MessageBoxIcon.Error);
		}

		return parameters;
	}

	// =======================================================================
	// РАБОТА С АТРИБУТАМИ
	// =======================================================================

	// Текстовое значение атрибута объекта; пустая строка, если атрибута нет
	// или он не заполнен.
	private string GetAttributeText(IDBObject obj, string attributeName)
	{
		IDBAttribute attribute = obj.GetAttributeByName(attributeName);
		if (attribute == null || attribute.Value == null)
			return string.Empty;

		return attribute.Value.ToString();
	}

	// Присвоение значения атрибуту объекта
	private void SetValue(IDBObject obj, string attributeName, List<string> warnings, params object[] values)
	{
		Assign(obj.Attributes.FindByName(attributeName), attributeName, warnings, values);
	}

	// Присвоение значения атрибуту связи
	private void SetValue(IDBRelation relation, string attributeName, List<string> warnings, params object[] values)
	{
		Assign(relation.Attributes.FindByName(attributeName), attributeName, warnings, values);
	}

	// Записывает в атрибут первое из значений, которое принимает его тип.
	private void Assign(IDBAttribute attribute, string attributeName, List<string> warnings, object[] values)
	{
		if (attribute == null)
		{
			warnings.Add("атрибут «" + attributeName + "» не найден");
			return;
		}

		foreach (object value in values)
		{
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

		warnings.Add("не удалось записать значение в атрибут «" + attributeName + "»");
	}

	// =======================================================================
	// ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ
	// =======================================================================

	// Идентификатор объекта пользователя, под которым выполнен вход в IPS.
	// Свойство с идентификатором в разных версиях API называется по-разному,
	// поэтому источники перебираются по очереди и без жёсткой привязки к имени:
	// служба текущего пользователя, пользовательская сессия и, как запасной
	// вариант, поиск объекта пользователя по его глобальному идентификатору.
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
}
