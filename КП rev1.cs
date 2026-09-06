using System;
using System.Collections.Generic;
using System.Data;
using System.Diagnostics;
using System.Windows.Forms;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Reflection;
using System.Threading;
using Intermech;
using Intermech.Forums;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;
using Intermech.Interfaces.Compositions;
using Intermech.Interfaces.Workflow;
using Intermech.Kernel.Search;
using Intermech.Client.Core;

public class Script
{
    public ICSharpScriptClientContext ScriptContext { get; set; }
    
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
    
    public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
    {
        object notesWS = null;
        object uiDoc = null;
        
        try
        {
            IUserSession session = parameters.UserSession;
            IDBObject currentObj = session.GetObject(parameters.ObjectID);
            
            // ======================================================
            // 1. СОЗДАНИЕ AUTH-ФАЙЛА
            // ======================================================
            IAuthFilesService authService = ServicesManager.GetService(typeof(IAuthFilesService)) as IAuthFilesService;
            if (authService != null)
            {
                AuthFileAssignEventArgs args = new AuthFileAssignEventArgs(
                currentObj.ObjectType,
                currentObj.ObjectID,
                true);
                
                authService.FireEventAuthFileAssign(args);
            }
            
            Thread.Sleep(1000);
            
            // ======================================================
            // 2. ИМЯ PDF = Обозначение документа
            // ======================================================
            IDBAttribute attrDocDesignation = currentObj.GetAttributeByGuid(
            new Guid("cad0001f-306c-11d8-b4e9-00304f19f545"));
            
            string docDesignation = (attrDocDesignation != null && attrDocDesignation.Value != null)
            ? attrDocDesignation.Value.ToString().Trim()
            : string.Empty;
            
            // ======================================================
            // 3. ИЗВЛЕЧЕНИЕ PDF
            // ======================================================
            string pdfPath = ExtractPdfToDisk(currentObj, docDesignation);
            
            if (string.IsNullOrEmpty(pdfPath) || !File.Exists(pdfPath))
            {
                MessageBox.Show("PDF не найден.");
                return parameters;
            }
            
            // ======================================================
            // 4. ПОИСК КОНТАКТОВ
            // ======================================================
            ICompositionLoadService compositionLoadService =
            session.GetCustomService(typeof(ICompositionLoadService)) as ICompositionLoadService;
            
            if (compositionLoadService == null)
            {
                MessageBox.Show("Не удалось получить ICompositionLoadService");
                return parameters;
            }
            
            Guid relationGuid = new Guid("cad00023-306c-11d8-b4e9-00304f19f545");
            List<int> relationTypes = new List<int>();
            relationTypes.Add(MetaDataHelper.GetRelationTypeID(relationGuid));
            
            List<int> parentIds = Load(
            compositionLoadService,
            session,
            (int)currentObj.ObjectID,
            currentObj.ObjectType,
            relationTypes,
            null,
            false,
            new ConditionStructure[] { });
            
            if (parentIds.Count == 0)
            {
                MessageBox.Show("Родительский объект не найден.");
                return parameters;
            }
            
            int contactTypeID = MetaDataHelper.GetObjectTypeID("7b228e7a-8f92-4121-8541-c64ecfbaf85d");
            
            List<int> filterTypes = new List<int>();
            filterTypes.Add(contactTypeID);
            
            List<int> contactIds = Load(
            compositionLoadService,
            session,
            parentIds[0],
            session.GetObject(parentIds[0]).ObjectType,
            relationTypes,
            filterTypes,
            true,
            new ConditionStructure[] { });
            
            if (contactIds.Count == 0)
            {
                MessageBox.Show("Контакты не найдены.");
                return parameters;
            }
            
            // ======================================================
            // 4.1. ФОРМИРУЕМ СПИСОК КОНТАКТОВ С ДОЛЖНОСТЬЮ
            // ======================================================
            List<ContactListItem> contactItems = new List<ContactListItem>();
            
            foreach (int id in contactIds)
            {
                IDBObject obj = session.GetObject(id);
                
                IDBAttribute attrPosition = obj.GetAttributeByGuid(
                new Guid("2c31988f-7d95-465a-bf04-7fabef411061"));
                
                string position = (attrPosition != null && attrPosition.Value != null)
                ? attrPosition.Value.ToString().Trim()
                : string.Empty;
                
                string caption = obj.Caption ?? "Без имени";
                
                string display = string.IsNullOrEmpty(position)
                ? caption
                : caption + " | " + position;
                
                contactItems.Add(new ContactListItem { Obj = obj, Display = display });
            }
            
            ContactListItem selectedItem = ShowSelectDialog(contactItems);
            if (selectedItem == null)
                return parameters;
            
            IDBObject selectedContact = selectedItem.Obj;
            
            // ======================================================
            // 5. ДАННЫЕ КОНТАКТА
            // ======================================================
            IDBAttribute attrEmail = selectedContact.GetAttributeByGuid(
            new Guid("fd89a6c4-05d3-435f-a137-7120c3f41e9f"));
            
            IDBAttribute attrDesignation = selectedContact.GetAttributeByGuid(
            new Guid("cad0001f-306c-11d8-b4e9-00304f19f545"));
            
            string emailValue = (attrEmail != null && attrEmail.Value != null)
            ? attrEmail.Value.ToString()
            : string.Empty;
            
            string designationValue = (attrDesignation != null && attrDesignation.Value != null)
            ? attrDesignation.Value.ToString().Trim()
            : string.Empty;
            
            string contactGuidStr = selectedContact.ObjectGUID.ToString();
            
            string nameContTitle = !string.IsNullOrEmpty(designationValue)
            ? designationValue
            : "Без названия";
            
            if (string.IsNullOrEmpty(emailValue))
            {
                MessageBox.Show("Адрес E-mail не найден.");
                return parameters;
            }
            
            // ======================================================
            // 5.1. ЛОГИКА ФОРМИРОВАНИЯ ОБРАЩЕНИЯ
            // ======================================================
            string finalName = "Коллеги";
            
            if (!string.IsNullOrEmpty(designationValue))
            {
                string[] words = designationValue.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                
                if (words.Length >= 3)
                    finalName = words[1] + " " + words[2];
                else if (words.Length == 2)
                    finalName = words[1];
                else if (words.Length == 1)
                    finalName = words[0];
            }
            
            // ======================================================
            // 6. ОТПРАВКА СООБЩЕНИЯ НА ФОРУМ (ДО Notes!)
            // ======================================================
            try
            {
                string attrTopic = "Отправка КП";
                string attrText = "КП направлено [ref=\"" + contactGuidStr + "\"]" + nameContTitle + "[/ref]";
                
                SendMessage(session, parentIds[0], attrTopic, attrText);
            }
            catch (Exception forumEx)
            {
                MessageBox.Show("Ошибка отправки на форум:\n" + forumEx.ToString(),
                "Ошибка форума", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            
            // ======================================================
            // 7. ФОРМИРОВАНИЕ ПИСЬМА
            // ======================================================
            string greeting = "Добрый день, " + finalName + "!";
            
            string bodyText =
            greeting + Environment.NewLine +
            "Направляю Вам коммерческое предложение на приобретение неисключительного права использования программного обеспечения ОДО «ИНТЕРМЕХ»"
            + Environment.NewLine + Environment.NewLine;
            
            string subject =
            "Коммерческое предложение на приобретение неисключительного права использования программного обеспечения ОДО «ИНТЕРМЕХ»";
            
            // ======================================================
            // 8. КОПИРУЕМ PDF В БУФЕР ОБМЕНА
            // ======================================================
            DataObject data = new DataObject();
            var sc = new System.Collections.Specialized.StringCollection();
            sc.Add(pdfPath);
            data.SetFileDropList(sc);
            Clipboard.SetDataObject(data, true);
            
            // ======================================================
            // 9. ОТКРЫВАЕМ NOTES ЧЕРЕЗ MAILTO
            // ======================================================
            string mailtoUrl = string.Format("mailto:{0}?subject={1}",
            emailValue,
            Uri.EscapeDataString(subject));
            
            Process.Start(new ProcessStartInfo(mailtoUrl) { UseShellExecute = true });
            
            Thread.Sleep(3000);
            
            // ======================================================
            // 10. ЧЕРЕЗ COM ВСТАВЛЯЕМ ТЕКСТ И PDF
            // ======================================================
            bool pasted = false;
            
            Type wsType = Type.GetTypeFromProgID("Notes.NotesUIWorkspace");
            if (wsType != null)
            {
                notesWS = Activator.CreateInstance(wsType);
                
                uiDoc = notesWS.GetType().InvokeMember(
                "CurrentDocument",
                BindingFlags.GetProperty,
                null,
                notesWS,
                null);
                
                if (uiDoc != null)
                {
                    uiDoc.GetType().InvokeMember(
                    "GotoField",
                    BindingFlags.InvokeMethod,
                    null,
                    uiDoc,
                    new object[] { "Body" });
                    
                    uiDoc.GetType().InvokeMember(
                    "InsertText",
                    BindingFlags.InvokeMethod,
                    null,
                    uiDoc,
                    new object[] { bodyText });
                    
                    uiDoc.GetType().InvokeMember(
                    "Paste",
                    BindingFlags.InvokeMethod,
                    null,
                    uiDoc,
                    null);
                    
                    pasted = true;
                }
                else
                {
                    MessageBox.Show(
                    "Notes открыл письмо с заполненным адресом получателя.\n" +
                    "Вставьте вложение из буфера обмена вручную (Ctrl+V).",
                    "Информация", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
            }
            
            // ======================================================
            // 11. УДАЛЕНИЕ PDF ПОСЛЕ УСПЕШНОЙ ВСТАВКИ
            // ======================================================
            if (pasted && File.Exists(pdfPath))
            {
                try { File.Delete(pdfPath); } catch { }
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("Ошибка: " + ex.ToString());
        }
        finally
        {
            if (uiDoc != null) Marshal.ReleaseComObject(uiDoc);
            if (notesWS != null) Marshal.ReleaseComObject(notesWS);
        }
        
        return parameters;
    }
    
    private static void SendMessage(IUserSession scriptSession, long objectID, string caption, string messageText)
    {
        IForumsService forumService = scriptSession.GetCustomService(typeof(IForumsService)) as IForumsService;
        if (forumService == null) throw new Exception("IForumsService not found");
        
        var fSvc = ServicesManager.GetService(typeof(IFiltrationService)) as IFiltrationService;
        if (fSvc == null) throw new Exception("IFiltrationService not found");
        
        ICurrentUserAndRole cc = ServicesManager.GetService(typeof(ICurrentUserAndRole)) as ICurrentUserAndRole;
        if (cc == null) throw new Exception("ICurrentUserAndRole not found");
        
        var obj = scriptSession.GetObject(objectID);
        if (obj == null) throw new Exception("Объект с ID=" + objectID + " не найден");
        
        var forum = forumService.GenerationForum(
        objectID, obj.ID, ForumFormat.Version,
        fSvc.FiltrationServiceOwnerID, scriptSession.SessionGUID);
        
        UserMessage message = new UserMessage
        {
            Caption = caption,
            Date = DateTime.UtcNow,
            Message = messageText,
            UserGuid = cc.UserGuid.ToString(),
            DiscussedObjectGuid = obj.GUID.ToString()
        };
        
        message.ReadByUsers.Add(cc.UserGuid.ToString());
        
        forumService.AddMessageToDiscussion(
        message, objectID, obj.ID, forum, scriptSession.SessionGUID);
    }
    
    private string ExtractPdfToDisk(IDBObject currentObj, string fileNameBase)
    {
        IDBAttribute attrFile = currentObj.GetAttributeByGuid(
        new Guid("cad0004b-306c-11d8-b4e9-00304f19f545"));
        
        if (attrFile == null)
            return null;
        
        string outDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
        "IPS_PDF");
        
        if (!Directory.Exists(outDir))
            Directory.CreateDirectory(outDir);
        
        string safeName = SanitizeFileName(fileNameBase);
        if (string.IsNullOrEmpty(safeName))
            safeName = "AuthFile_" + currentObj.ObjectID;
        
        for (int index = 0; index < 20; index++)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                BlobProcReader reader = new BlobProcReader(
                currentObj.ObjectID,
                AttributableElements.Object,
                attrFile.AttributeID,
                index,
                0,
                ms,
                null,
                null);
                
                reader.ReadData();
                
                if (reader.Result && ms.Length > 0)
                {
                    byte[] data = ms.ToArray();
                    
                    if (data.Length > 4 &&
                    data[0] == 0x25 &&
                    data[1] == 0x50 &&
                    data[2] == 0x44 &&
                    data[3] == 0x46)
                    {
                        string path = Path.Combine(outDir, safeName + ".pdf");
                        
                        File.WriteAllBytes(path, data);
                        return path;
                    }
                }
            }
        }
        
        return null;
    }
    
    private static string SanitizeFileName(string name)
    {
        if (string.IsNullOrEmpty(name))
            return string.Empty;
        
        foreach (char c in Path.GetInvalidFileNameChars())
        name = name.Replace(c, '_');
        
        return name.Trim();
    }
    
    private static List<int> Load(
    ICompositionLoadService compositionLoadService,
    IUserSession scriptSession,
    int objId,
    int objTypeId,
    List<int> searchRelationTypes,
    List<int> searchObjectType,
    bool composition,
    ConditionStructure[] conds)
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
        conds,
        SystemGUIDs.filtrationAllVersions,
        null,
        -1);
        
        if (table != null)
        {
            foreach (DataRow row in table.Rows)
            {
                int id;
                if (int.TryParse(row[Consts.F_OBJECT_ID].ToString(), out id))
                    idList.Add(id);
            }
        }
        
        return idList;
    }
    
    private ContactListItem ShowSelectDialog(List<ContactListItem> items)
    {
        using (Form form = new Form())
        {
            ListBox listBox = new ListBox();
            Button btn = new Button();
            
            form.Text = "Выбор получателя";
            form.Size = new Size(520, 320);
            
            listBox.SetBounds(10, 10, 480, 220);
            
            foreach (var item in items)
            listBox.Items.Add(item);
            
            btn.Text = "Подготовить письмо";
            btn.DialogResult = DialogResult.OK;
            btn.SetBounds(170, 240, 180, 30);
            
            form.Controls.Add(listBox);
            form.Controls.Add(btn);
            
            return form.ShowDialog() == DialogResult.OK &&
            listBox.SelectedItem != null
            ? (ContactListItem)listBox.SelectedItem
            : null;
        }
    }
}
