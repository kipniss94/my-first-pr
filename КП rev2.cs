using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Data;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Intermech;
using Intermech.Forums;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;
using Intermech.Interfaces.Compositions;
using Intermech.Interfaces.Workflow;
using Intermech.Kernel.Search;
using Intermech.Client.Core;

// ===========================================================================
// Подготовка письма в Lotus Notes с вложенным PDF объекта, с карточки
// которого вызван скрипт.
//
// Порядок работы:
//   1) запрашивается auth-файл объекта и из атрибута «Файлы» извлекается PDF;
//   2) по связи «Простая связь между объектами» находится родительский объект
//      (предприятие) и его контакты; получатель выбирается в диалоге;
//   3) в обсуждение родительского объекта пишется сообщение об отправке;
//   4) через mailto открывается Notes, текст письма и вложение из буфера
//      обмена вставляются через COM.
//
// Тексты письма и сообщения в обсуждении зависят от типа объекта:
//   «Письмо» — тема берётся из атрибута «Тема сообщения», в теле «Письмо
//              во вложении», в обсуждении «Отправка письма» / «Письмо
//              направлено …»;
//   остальные типы (коммерческое предложение) — тексты о КП.
// ===========================================================================
public class Script
{
	public ICSharpScriptClientContext ScriptContext { get; set; }

	// --- метаданные (GUID берутся из конфигуратора базы) ---
	private readonly Guid RelationSimpleGuid = new Guid("cad00023-306c-11d8-b4e9-00304f19f545");
	private readonly Guid ContactTypeGuid = new Guid("7b228e7a-8f92-4121-8541-c64ecfbaf85d");
	private readonly Guid AttrDesignationGuid = new Guid("cad0001f-306c-11d8-b4e9-00304f19f545");
	private readonly Guid AttrPositionGuid = new Guid("2c31988f-7d95-465a-bf04-7fabef411061");
	private readonly Guid AttrEmailGuid = new Guid("fd89a6c4-05d3-435f-a137-7120c3f41e9f");
	private readonly Guid AttrFilesGuid = new Guid("cad0004b-306c-11d8-b4e9-00304f19f545");

	// Тип объекта и атрибут, по которым письмо отличается от коммерческого предложения
	private const string LetterTypeName = "Письмо";
	private const string AttrMessageSubjectName = "Тема сообщения";

	// --- тексты ---
	private const string OfferSubject =
		"Коммерческое предложение на приобретение неисключительного права использования программного обеспечения ОДО «ИНТЕРМЕХ»";
	private const string OfferBodyLine =
		"Направляю Вам коммерческое предложение на приобретение неисключительного права использования программного обеспечения ОДО «ИНТЕРМЕХ»";
	private const string OfferForumTopic = "Отправка КП";
	private const string OfferForumPrefix = "КП направлено ";

	private const string LetterBodyLine = "Письмо во вложении";
	private const string LetterForumTopic = "Отправка письма";
	private const string LetterForumPrefix = "Письмо направлено ";

	private const string DialogCaption = "Подготовка письма";

	// --- параметры ожидания ---
	private const int MaxFileValues = 20;      // сколько значений атрибута «Файлы» просматривать
	private const int PdfWaitSeconds = 10;     // сколько ждать появления auth-файла (PDF)
	private const int NotesWaitSeconds = 15;   // сколько ждать открытия письма в Notes

	// Обёртка для ListBox: отображаем текст, возвращаем объект
	private class ContactListItem
	{
		public IDBObject Obj { get; set; }
		public string Display { get; set; }

		public override string ToString()
		{
			return Display;
		}
	}

	// Тексты, зависящие от типа объекта
	private class MessageProfile
	{
		public string Subject;
		public string BodyLine;
		public string ForumTopic;
		public string ForumPrefix;
	}

	public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
	{
		object notesWS = null;
		object uiDoc = null;
		string pdfPath = null;
		bool pasted = false;

		try
		{
			IUserSession session = parameters.UserSession;
			IDBObject currentObj = session.GetObject(parameters.ObjectID);
			if (currentObj == null)
			{
				Show("Не удалось получить объект, с карточки которого вызван скрипт.", MessageBoxIcon.Error);
				return parameters;
			}

			// ==================================================
			// 1. ЗАПРОС AUTH-ФАЙЛА
			// ==================================================
			IAuthFilesService authService = ServicesManager.GetService(typeof(IAuthFilesService)) as IAuthFilesService;
			if (authService != null)
			{
				authService.FireEventAuthFileAssign(
					new AuthFileAssignEventArgs(currentObj.ObjectType, currentObj.ObjectID, true));
			}

			// ==================================================
			// 2. ИЗВЛЕЧЕНИЕ PDF (имя файла = обозначение документа)
			// ==================================================
			string docDesignation = GetAttributeText(currentObj, AttrDesignationGuid);

			// Auth-файл формируется не мгновенно, поэтому PDF не ждём фиксированную
			// паузу, а опрашиваем атрибут «Файлы», пока он не появится.
			pdfPath = WaitForPdf(currentObj, docDesignation);
			if (string.IsNullOrEmpty(pdfPath))
			{
				Show("PDF не найден: в атрибуте «Файлы» объекта нет PDF-документа.", MessageBoxIcon.Warning);
				return parameters;
			}

			// ==================================================
			// 3. РОДИТЕЛЬСКИЙ ОБЪЕКТ И ЕГО КОНТАКТЫ
			// ==================================================
			ICompositionLoadService compositionLoadService =
				session.GetCustomService(typeof(ICompositionLoadService)) as ICompositionLoadService;

			if (compositionLoadService == null)
			{
				Show("Не удалось получить службу чтения составов (ICompositionLoadService).", MessageBoxIcon.Error);
				return parameters;
			}

			List<int> relationTypes = new List<int>();
			relationTypes.Add(MetaDataHelper.GetRelationTypeID(RelationSimpleGuid));

			List<int> parentIds = Load(
				compositionLoadService, session,
				(int)currentObj.ObjectID, currentObj.ObjectType,
				relationTypes, null, false);

			if (parentIds.Count == 0)
			{
				Show("Родительский объект не найден.", MessageBoxIcon.Warning);
				return parameters;
			}

			int parentId = parentIds[0];
			IDBObject parentObj = session.GetObject(parentId);
			if (parentObj == null)
			{
				Show("Не удалось получить родительский объект.", MessageBoxIcon.Error);
				return parameters;
			}

			List<int> filterTypes = new List<int>();
			filterTypes.Add(MetaDataHelper.GetObjectTypeID(ContactTypeGuid));

			List<int> contactIds = Load(
				compositionLoadService, session,
				parentId, parentObj.ObjectType,
				relationTypes, filterTypes, true);

			if (contactIds.Count == 0)
			{
				Show("Контакты не найдены.", MessageBoxIcon.Warning);
				return parameters;
			}

			// ==================================================
			// 4. ВЫБОР ПОЛУЧАТЕЛЯ
			// ==================================================
			List<ContactListItem> contactItems = new List<ContactListItem>();

			foreach (int id in contactIds)
			{
				IDBObject contact = session.GetObject(id);
				if (contact == null)
					continue;

				string position = GetAttributeText(contact, AttrPositionGuid);
				string caption = contact.Caption ?? "Без имени";

				contactItems.Add(new ContactListItem
				{
					Obj = contact,
					Display = string.IsNullOrEmpty(position) ? caption : caption + " | " + position
				});
			}

			ContactListItem selectedItem = ShowSelectDialog(contactItems);
			if (selectedItem == null)
				return parameters; // пользователь отменил выбор

			IDBObject selectedContact = selectedItem.Obj;

			string emailValue = GetAttributeText(selectedContact, AttrEmailGuid);
			if (string.IsNullOrEmpty(emailValue))
			{
				Show("У выбранного контакта не заполнен адрес e-mail.", MessageBoxIcon.Warning);
				return parameters;
			}

			string designationValue = GetAttributeText(selectedContact, AttrDesignationGuid);
			string contactGuidStr = selectedContact.ObjectGUID.ToString();
			string nameContTitle = string.IsNullOrEmpty(designationValue) ? "Без названия" : designationValue;

			// ==================================================
			// 5. ТЕКСТЫ ПИСЬМА И СООБЩЕНИЯ (зависят от типа объекта)
			// ==================================================
			MessageProfile profile = BuildProfile(currentObj, docDesignation);

			// ==================================================
			// 6. СООБЩЕНИЕ В ОБСУЖДЕНИЕ (до открытия Notes)
			// ==================================================
			try
			{
				SendMessage(session, parentId, profile.ForumTopic,
					profile.ForumPrefix + "[ref=\"" + contactGuidStr + "\"]" + nameContTitle + "[/ref]");
			}
			catch (Exception forumEx)
			{
				Show("Ошибка отправки сообщения в обсуждение:" + Environment.NewLine + forumEx.Message,
					MessageBoxIcon.Error);
			}

			// ==================================================
			// 7. ТЕЛО ПИСЬМА И ВЛОЖЕНИЕ В БУФЕРЕ ОБМЕНА
			// ==================================================
			string bodyText =
				"Добрый день, " + BuildGreetingName(designationValue) + "!" + Environment.NewLine +
				profile.BodyLine + Environment.NewLine + Environment.NewLine;

			DataObject data = new DataObject();
			StringCollection files = new StringCollection();
			files.Add(pdfPath);
			data.SetFileDropList(files);
			Clipboard.SetDataObject(data, true);

			// ==================================================
			// 8. ОТКРЫТИЕ ПИСЬМА В NOTES ЧЕРЕЗ MAILTO
			// ==================================================
			string mailtoUrl = string.Format("mailto:{0}?subject={1}",
				emailValue, Uri.EscapeDataString(profile.Subject));

			try
			{
				Process.Start(new ProcessStartInfo(mailtoUrl) { UseShellExecute = true });
			}
			catch (Exception startEx)
			{
				Show("Не удалось открыть почтовый клиент:" + Environment.NewLine + startEx.Message,
					MessageBoxIcon.Error);
				return parameters;
			}

			// ==================================================
			// 9. ВСТАВКА ТЕКСТА И ВЛОЖЕНИЯ ЧЕРЕЗ COM
			// ==================================================
			Type wsType = Type.GetTypeFromProgID("Notes.NotesUIWorkspace");
			if (wsType == null)
			{
				Show("Lotus Notes не зарегистрирован в системе (Notes.NotesUIWorkspace)." + Environment.NewLine +
					"Письмо открыто по адресу получателя, вложение — в буфере обмена (Ctrl+V).",
					MessageBoxIcon.Information);
				return parameters;
			}

			notesWS = Activator.CreateInstance(wsType);

			// Notes открывает письмо не мгновенно: ждём появления документа,
			// а не фиксированную паузу.
			uiDoc = WaitForNotesDocument(notesWS);

			if (uiDoc == null)
			{
				Show("Notes открыл письмо с заполненным адресом получателя." + Environment.NewLine +
					"Вставьте вложение из буфера обмена вручную (Ctrl+V).",
					MessageBoxIcon.Information);
				return parameters;
			}

			InvokeNotes(uiDoc, "GotoField", new object[] { "Body" });
			InvokeNotes(uiDoc, "InsertText", new object[] { bodyText });
			InvokeNotes(uiDoc, "Paste", null);
			pasted = true;
		}
		catch (Exception ex)
		{
			Show("Ошибка: " + ex.Message, MessageBoxIcon.Error);
		}
		finally
		{
			// Временный PDF нужен только до вставки в письмо
			if (pasted && !string.IsNullOrEmpty(pdfPath))
			{
				try { File.Delete(pdfPath); }
				catch { }
			}

			if (uiDoc != null) try { Marshal.ReleaseComObject(uiDoc); } catch { }
			if (notesWS != null) try { Marshal.ReleaseComObject(notesWS); } catch { }
		}

		return parameters;
	}

	// =======================================================================
	// ТЕКСТЫ, ЗАВИСЯЩИЕ ОТ ТИПА ОБЪЕКТА
	// =======================================================================

	// Для объектов типа «Письмо» тема берётся из атрибута «Тема сообщения»,
	// для остальных типов используются тексты коммерческого предложения.
	private MessageProfile BuildProfile(IDBObject currentObj, string docDesignation)
	{
		if (!IsLetter(currentObj))
		{
			return new MessageProfile
			{
				Subject = OfferSubject,
				BodyLine = OfferBodyLine,
				ForumTopic = OfferForumTopic,
				ForumPrefix = OfferForumPrefix
			};
		}

		string subject = GetAttributeText(currentObj, AttrMessageSubjectName);
		if (string.IsNullOrEmpty(subject))
			subject = docDesignation; // запасной вариант: обозначение документа

		return new MessageProfile
		{
			Subject = subject,
			BodyLine = LetterBodyLine,
			ForumTopic = LetterForumTopic,
			ForumPrefix = LetterForumPrefix
		};
	}

	// Тип объекта сверяется и по наименованию типа, и по идентификатору типа,
	// найденному по этому наименованию: в разных базах GetObjectTypeName может
	// возвращать как наименование типа, так и наименование объекта.
	private bool IsLetter(IDBObject currentObj)
	{
		try
		{
			string typeName = MetaDataHelper.GetObjectTypeName(currentObj.ObjectType);
			if (!string.IsNullOrEmpty(typeName) &&
				string.Compare(typeName.Trim(), LetterTypeName, StringComparison.CurrentCultureIgnoreCase) == 0)
			{
				return true;
			}
		}
		catch
		{
			// наименование типа недоступно — проверяем по идентификатору
		}

		try
		{
			return MetaDataHelper.GetObjectTypeIDFromName(LetterTypeName) == currentObj.ObjectType;
		}
		catch
		{
			return false;
		}
	}

	// Обращение: из «Иванов Иван Иванович» получаем «Иван Иванович».
	private string BuildGreetingName(string designationValue)
	{
		if (string.IsNullOrEmpty(designationValue))
			return "Коллеги";

		string[] words = designationValue.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);

		if (words.Length >= 3)
			return words[1] + " " + words[2];

		if (words.Length == 2)
			return words[1];

		if (words.Length == 1)
			return words[0];

		return "Коллеги";
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

	private string GetAttributeText(IDBObject obj, string attributeName)
	{
		IDBAttribute attribute = obj.GetAttributeByName(attributeName);
		return (attribute == null || attribute.Value == null)
			? string.Empty
			: attribute.Value.ToString().Trim();
	}

	// =======================================================================
	// PDF ИЗ АТРИБУТА «ФАЙЛЫ»
	// =======================================================================

	// Ожидание auth-файла: PDF появляется в атрибуте не сразу после запроса,
	// поэтому чтение повторяется до PdfWaitSeconds секунд.
	private string WaitForPdf(IDBObject currentObj, string fileNameBase)
	{
		for (int second = 0; second < PdfWaitSeconds; second++)
		{
			string path = ExtractPdfToDisk(currentObj, fileNameBase);
			if (!string.IsNullOrEmpty(path))
				return path;

			Thread.Sleep(1000);
		}

		return null;
	}

	private string ExtractPdfToDisk(IDBObject currentObj, string fileNameBase)
	{
		IDBAttribute attrFile = currentObj.GetAttributeByGuid(AttrFilesGuid);
		if (attrFile == null)
			return null;

		string outDir = Path.Combine(
			Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "IPS_PDF");

		string safeName = SanitizeFileName(fileNameBase);
		if (string.IsNullOrEmpty(safeName))
			safeName = "AuthFile_" + currentObj.ObjectID;

		for (int index = 0; index < MaxFileValues; index++)
		{
			using (MemoryStream stream = new MemoryStream())
			{
				BlobProcReader reader;
				try
				{
					reader = new BlobProcReader(
						currentObj.ObjectID, AttributableElements.Object, attrFile.AttributeID,
						index, 0, stream, null, null);

					reader.ReadData();
				}
				catch
				{
					break; // значения атрибута закончились
				}

				if (!reader.Result || stream.Length == 0)
					continue;

				byte[] data = stream.ToArray();
				if (!IsPdf(data))
					continue;

				if (!Directory.Exists(outDir))
					Directory.CreateDirectory(outDir);

				string path = Path.Combine(outDir, safeName + ".pdf");
				File.WriteAllBytes(path, data);
				return path;
			}
		}

		return null;
	}

	// Сигнатура PDF: %PDF
	private bool IsPdf(byte[] data)
	{
		return data.Length > 4 &&
			data[0] == 0x25 && data[1] == 0x50 && data[2] == 0x44 && data[3] == 0x46;
	}

	private static string SanitizeFileName(string name)
	{
		if (string.IsNullOrEmpty(name))
			return string.Empty;

		foreach (char symbol in Path.GetInvalidFileNameChars())
			name = name.Replace(symbol, '_');

		return name.Trim();
	}

	// =======================================================================
	// LOTUS NOTES
	// =======================================================================

	// Открытое письмо появляется в Notes с задержкой: ждём документ,
	// а не фиксированную паузу.
	private object WaitForNotesDocument(object notesWS)
	{
		for (int second = 0; second < NotesWaitSeconds; second++)
		{
			try
			{
				object uiDoc = notesWS.GetType().InvokeMember(
					"CurrentDocument", BindingFlags.GetProperty, null, notesWS, null);

				if (uiDoc != null)
					return uiDoc;
			}
			catch
			{
				// Notes ещё не готов отвечать — пробуем ещё раз
			}

			Thread.Sleep(1000);
		}

		return null;
	}

	private void InvokeNotes(object uiDoc, string methodName, object[] methodParameters)
	{
		uiDoc.GetType().InvokeMember(methodName, BindingFlags.InvokeMethod, null, uiDoc, methodParameters);
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
	// СОСТАВЫ
	// =======================================================================

	private static List<int> Load(
		ICompositionLoadService compositionLoadService,
		IUserSession scriptSession,
		int objId,
		int objTypeId,
		List<int> searchRelationTypes,
		List<int> searchObjectType,
		bool composition)
	{
		List<int> idList = new List<int>();

		DataTable table = compositionLoadService.LoadComposition(
			scriptSession,
			objId,
			objTypeId,
			searchRelationTypes,
			searchObjectType,
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
	// ДИАЛОГ ВЫБОРА ПОЛУЧАТЕЛЯ
	// =======================================================================

	private ContactListItem ShowSelectDialog(List<ContactListItem> items)
	{
		using (Form form = new Form())
		{
			ListBox listBox = new ListBox();
			Button btnOk = new Button();
			Button btnCancel = new Button();

			form.Text = "Выбор получателя";
			form.ClientSize = new Size(520, 320);
			form.FormBorderStyle = FormBorderStyle.Sizable;
			form.StartPosition = FormStartPosition.CenterScreen;
			form.MinimizeBox = false;
			form.MaximizeBox = false;

			listBox.SetBounds(10, 10, 500, 250);
			listBox.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;

			foreach (ContactListItem item in items)
				listBox.Items.Add(item);

			if (listBox.Items.Count > 0)
				listBox.SelectedIndex = 0;

			// двойной щелчок по контакту равнозначен нажатию кнопки
			listBox.DoubleClick += delegate
			{
				if (listBox.SelectedItem != null)
					form.DialogResult = DialogResult.OK;
			};

			btnOk.Text = "Подготовить письмо";
			btnOk.DialogResult = DialogResult.OK;
			btnOk.SetBounds(230, 275, 160, 30);
			btnOk.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;

			btnCancel.Text = "Отмена";
			btnCancel.DialogResult = DialogResult.Cancel;
			btnCancel.SetBounds(400, 275, 110, 30);
			btnCancel.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;

			form.Controls.Add(listBox);
			form.Controls.Add(btnOk);
			form.Controls.Add(btnCancel);
			form.AcceptButton = btnOk;
			form.CancelButton = btnCancel;

			return form.ShowDialog() == DialogResult.OK
				? listBox.SelectedItem as ContactListItem
				: null;
		}
	}

	// =======================================================================
	// СООБЩЕНИЯ
	// =======================================================================

	private void Show(string text, MessageBoxIcon icon)
	{
		MessageBox.Show(text, DialogCaption, MessageBoxButtons.OK, icon);
	}
}
