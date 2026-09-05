using System;
using System.Collections;
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

	// Глобальный идентификатор типа связи «Связь задачи органайзера с ресурсами».
	// Если он известен в вашей базе — впишите его сюда: тип связи будет найден
	// сразу, без перебора наименований (см. ResolveRelationTypeID).
	private const string TaskResourceRelationGuid = "";

	// Верхняя граница перебора идентификаторов типов связей
	private const int MaxRelationTypeID = 10000;

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
				catch (Intermech.ObjectAlreadyExists)
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
				List<string> similarRelations = new List<string>();
				int relationTypeID = ResolveRelationTypeID(TaskResourceRelationName, similarRelations);

				if (relationTypeID <= 0)
				{
					string message = "не найден тип связи «" + TaskResourceRelationName + "»";
					if (similarRelations.Count > 0)
						message += " (похожие типы связей: " + string.Join("; ", similarRelations.ToArray()) + ")";

					warnings.Add(message);
					ShowWarnings(warnings);
					return parameters;
				}

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

					// «Напомнить за (интервал)»: интервал может храниться как число
					// минут/секунд, как доля суток, как время или как значение из
					// списка. Если не подойдёт ни один вариант, в сообщении будут
					// тип атрибута, его текущее значение и допустимые значения.
					SetValue(taskUserRelation, AttrRemindBeforeName, warnings,
						RemindBeforeMinutes,                                    // минуты (целое)
						(double)RemindBeforeMinutes,                            // минуты (вещественное)
						RemindBeforeMinutes * 60,                               // секунды
						RemindBeforeMinutes / 1440.0,                           // доля суток
						TimeSpan.FromMinutes(RemindBeforeMinutes),              // интервал
						new DateTime(1899, 12, 30).AddMinutes(RemindBeforeMinutes), // время как дата
						"00:" + RemindBeforeMinutes.ToString("00") + ":00",     // 00:15:00
						"0:" + RemindBeforeMinutes,                             // 0:15
						RemindBeforeMinutes.ToString(),                         // "15"
						RemindBeforeMinutes + " мин.",
						RemindBeforeMinutes + " минут",
						"за " + RemindBeforeMinutes + " мин.");
				}
			}

			ShowWarnings(warnings);
		}
		catch (Exception ex)
		{
			Show("Ошибка при создании задачи органайзера: " + ex.Message, MessageBoxIcon.Error);
		}

		return parameters;
	}

	// =======================================================================
	// ТИП СВЯЗИ
	// =======================================================================

	// Идентификатор типа связи по её наименованию.
	// Поиска типа связи по имени в MetaDataHelper нет (в отличие от типов
	// объектов), поэтому используется обратное преобразование
	// GetRelationTypeName(id): идентификаторы перебираются, пока не встретится
	// нужное наименование. Если глобальный идентификатор связи задан в
	// константе TaskResourceRelationGuid, перебор не выполняется.
	// В similarRelations собираются похожие наименования — они попадают
	// в сообщение, если нужный тип связи не найден.
	private int ResolveRelationTypeID(string relationName, List<string> similarRelations)
	{
		if (!string.IsNullOrEmpty(TaskResourceRelationGuid))
		{
			try
			{
				int relationTypeID = MetaDataHelper.GetRelationTypeID(TaskResourceRelationGuid);
				if (relationTypeID > 0)
					return relationTypeID;
			}
			catch
			{
				// неверный или неизвестный в этой базе идентификатор — ищем по наименованию
			}
		}

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

			if (string.IsNullOrEmpty(name))
				continue;

			if (string.Compare(name.Trim(), relationName, StringComparison.CurrentCultureIgnoreCase) == 0)
				return relationTypeID;

			if (similarRelations != null &&
				name.IndexOf("органайзер", StringComparison.CurrentCultureIgnoreCase) >= 0)
			{
				similarRelations.Add("[" + relationTypeID + "] " + name);
			}
		}

		return -1;
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

		// Причины отказа по каждому варианту — попадают в сообщение, если
		// не подойдёт ни один из них.
		List<string> attempts = new List<string>();

		foreach (object value in values)
		{
			try
			{
				attribute.Value = value;
				return;
			}
			catch (Exception ex)
			{
				attempts.Add(DescribeValue(value) + " → " + ex.Message);
			}
		}

		StringBuilder message = new StringBuilder();
		message.Append("не удалось записать значение в атрибут «" + attributeName + "»");
		message.Append(Environment.NewLine + "  атрибут: " + DescribeAttribute(attribute));

		foreach (string attempt in attempts)
			message.Append(Environment.NewLine + "  " + attempt);

		warnings.Add(message.ToString());
	}

	// Краткое описание значения: тип и содержимое.
	private string DescribeValue(object value)
	{
		if (value == null)
			return "null";

		return value.GetType().Name + " \"" + value + "\"";
	}

	// Описание атрибута для диагностики: простые свойства обработчика (тип поля,
	// идентификатор, текущее значение) и, если атрибут ограничен списком, —
	// допустимые значения. Набор свойств IDBAttribute зависит от версии API,
	// поэтому читается через reflection.
	private string DescribeAttribute(IDBAttribute attribute)
	{
		StringBuilder description = new StringBuilder();
		BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy;

		foreach (PropertyInfo property in attribute.GetType().GetProperties(flags))
		{
			if (!property.CanRead || property.GetIndexParameters().Length > 0)
				continue;

			object value;
			try
			{
				value = property.GetValue(attribute, null);
			}
			catch
			{
				continue;
			}

			if (value == null)
				continue;

			// в описание попадают только простые значения (числа, строки,
			// перечисления, даты) — коллекции и обработчики пропускаются
			if (!(value is string) && !(value is ValueType))
				continue;

			if (description.Length > 0)
				description.Append(", ");

			description.Append(property.Name + "=" + value);
		}

		string possibleValues = GetPossibleValues(attribute);
		if (!string.IsNullOrEmpty(possibleValues))
			description.Append(Environment.NewLine + "  допустимые значения: " + possibleValues);

		return description.ToString();
	}

	// Допустимые значения атрибута-списка: сначала у самого обработчика
	// атрибута, затем у MetaDataHelper по идентификатору атрибута.
	private string GetPossibleValues(IDBAttribute attribute)
	{
		string[] propertyNames = new string[]
		{
			"PossibleValues", "AllowedValues", "ListValues", "ValuesList", "EnumValues", "Values"
		};

		BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.FlattenHierarchy;

		foreach (string propertyName in propertyNames)
		{
			PropertyInfo property = attribute.GetType().GetProperty(propertyName, flags);
			if (property == null || !property.CanRead)
				continue;

			try
			{
				string list = FormatEnumerable(property.GetValue(attribute, null));
				if (!string.IsNullOrEmpty(list))
					return list;
			}
			catch
			{
				// свойство недоступно — пробуем следующее
			}
		}

		int attributeID;
		try
		{
			attributeID = attribute.AttributeID;
		}
		catch
		{
			return string.Empty;
		}

		foreach (MethodInfo method in typeof(MetaDataHelper).GetMethods(BindingFlags.Public | BindingFlags.Static))
		{
			ParameterInfo[] methodParameters = method.GetParameters();
			if (methodParameters.Length != 1 || methodParameters[0].ParameterType != typeof(int))
				continue;

			if (method.Name.IndexOf("Value", StringComparison.OrdinalIgnoreCase) < 0)
				continue;

			try
			{
				string list = FormatEnumerable(method.Invoke(null, new object[] { attributeID }));
				if (!string.IsNullOrEmpty(list))
					return method.Name + ": " + list;
			}
			catch
			{
				// метод не подошёл — пробуем следующий
			}
		}

		return string.Empty;
	}

	// Первые значения перечислимого результата одной строкой.
	private string FormatEnumerable(object value)
	{
		IEnumerable items = value as IEnumerable;
		if (items == null || value is string)
			return string.Empty;

		StringBuilder text = new StringBuilder();
		int count = 0;

		foreach (object item in items)
		{
			if (item == null)
				continue;

			if (text.Length > 0)
				text.Append(" | ");

			text.Append(item.ToString());

			if (++count >= 20)
			{
				text.Append(" | ...");
				break;
			}
		}

		return text.ToString();
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

	// Итоговое сообщение о том, что осталось незаполненным (если такое есть).
	private void ShowWarnings(List<string> warnings)
	{
		if (warnings == null || warnings.Count == 0)
			return;

		StringBuilder text = new StringBuilder("Задача органайзера создана, но заполнены не все данные:");
		foreach (string warning in warnings)
			text.Append(Environment.NewLine + "- " + warning);

		Show(text.ToString(), MessageBoxIcon.Warning);
	}
}
