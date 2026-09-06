using System;
using System.Collections.Generic;
using System.Data;
using System.Runtime.InteropServices;
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
using System.Drawing;

public class Script
{
    public Intermech.Interfaces.Client.ICSharpScriptClientContext ScriptContext { get; set; }

    // Класс для хранения результата диалога
    public class InputResult
    {
        public string Comment { get; set; }
        public DateTime SelectedDate { get; set; }
    }

    public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
    {
        string nameContTitle = "Без названия";
        string phoneValue = string.Empty;
        string contactGuidStr = string.Empty;
        InputResult dialogResult = null;

        // --- БЛОК 1: Извлечение данных ---
        try
        {
            IUserSession session = parameters.UserSession;
            IDBObject cont = session.GetObject(parameters.ObjectID);
            contactGuidStr = cont.ObjectGUID.ToString();

            IDBAttribute attrTel1 = cont.GetAttributeByGuid(new Guid("6ba3b789-c888-48ad-9863-ea533b3c7939")); // телефон
            IDBAttribute attrNameCont = cont.GetAttributeByGuid(new Guid("cad0001f-306c-11d8-b4e9-00304f19f545")); // Обозначение контакта

            if (attrTel1 != null && attrTel1.Value != null)
                phoneValue = attrTel1.Value.ToString();

            if (attrNameCont != null && attrNameCont.Value != null)
                nameContTitle = attrNameCont.Value.ToString();

            if (string.IsNullOrEmpty(phoneValue))
            {
                MessageBox.Show("Атрибут 'Телефон' не содержит данных. Скрипт завершен.");
                return parameters;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("Ошибка при извлечении данных: " + ex.Message);
            return parameters;
        }

        // --- БЛОК 2: ЭМУЛЯЦИЯ ЗВОНКА ---
        try
        {
            Clipboard.SetText(phoneValue);
            Thread.Sleep(100);
            PressCtrlShiftE();
            Thread.Sleep(1500);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Ошибка телефонии: " + ex.Message);
        }

        // --- БЛОК 3: ДИАЛОГ ВВОДА ---
        try
        {
            dialogResult = InputBoxHelper.ShowMultiLineInputBox("Результат звонка", "Дата следующего контакта и комментарий:");
            if (dialogResult == null) return parameters; // Пользователь нажал отмену
        }
        catch (Exception ex)
        {
            MessageBox.Show("Ошибка окна ввода: " + ex.Message);
            return parameters;
        }

        // --- БЛОК 4: ПОИСК РОДИТЕЛЯ И ОБНОВЛЕНИЕ ВЫБРАННОЙ ДАТОЙ ---
        ICompositionLoadService compositionLoadService = parameters.UserSession.GetCustomService(typeof(ICompositionLoadService)) as ICompositionLoadService;
        IDBObject currentObj = parameters.UserSession.GetObject(parameters.ObjectID);

        var objectdIds = Load(compositionLoadService, parameters.UserSession, (int)currentObj.ObjectID, currentObj.ObjectType,
            new List<int> { MetaDataHelper.GetRelationTypeID("cad00023-306c-11d8-b4e9-00304f19f545") }, null, false, new ConditionStructure[] { });

        if (objectdIds.Count > 0)
        {
            long targetId = objectdIds[0];
            IDBObject parentObj = parameters.UserSession.GetObject(targetId);
            if (parentObj != null)
            {
                IDBAttribute attrData1 = parentObj.GetAttributeByGuid(new Guid("70448372-c797-4a51-b923-a810436107b5")); //Дата последнего контакта
                if (attrData1 != null)
                    attrData1.Value = DateTime.Now;

                IDBAttribute attrData2 = parentObj.GetAttributeByGuid(new Guid("50676414-494a-498d-bae1-4e1af2b7e172")); //Дата следующего контакта
                if (attrData2 != null)
                    attrData2.Value = dialogResult.SelectedDate; 
            }
        }

        // --- БЛОК 5: ОТПРАВКА НА ФОРУМ ---
        if (objectdIds.Count > 0)
        {
            string attrTopic = "Звонок";
            string attrText = "Результат общения с [ref=\"" + contactGuidStr + "\"]" + nameContTitle + "[/ref]: ";
            attrText += Environment.NewLine + (string.IsNullOrEmpty(dialogResult.Comment) ? "" : dialogResult.Comment);

            SendMessage(parameters.UserSession, objectdIds[0], attrTopic, attrText);
        }

        try { Clipboard.SetText(phoneValue); } catch { }

        return parameters;
    }

    // --- ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ ---

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

    public static class InputBoxHelper
    {
        public static InputResult ShowMultiLineInputBox(string title, string prompt)
        {
            using (Form form = new Form())
            {
                Label label = new Label();
                DateTimePicker datePicker = new DateTimePicker();
                TextBox textBox = new TextBox();
                Button buttonOk = new Button();
                Button buttonCancel = new Button();
                Button buttonNoAnswer = new Button();

                form.Text = title;
                label.Text = prompt;
                buttonOk.Text = "ОК";
                buttonCancel.Text = "Отмена";
                buttonNoAnswer.Text = "Не дозвонился";

                buttonOk.DialogResult = DialogResult.OK;
                buttonCancel.DialogResult = DialogResult.Cancel;

                // Настройки формы
                form.ClientSize = new System.Drawing.Size(400, 250);
                label.SetBounds(9, 10, 380, 13);
                
                // Календарь
                datePicker.SetBounds(12, 30, 200, 20);
                datePicker.Format = DateTimePickerFormat.Short;

                // Поле комментария
                textBox.SetBounds(12, 60, 376, 140);
                textBox.Multiline = true;
                textBox.ScrollBars = ScrollBars.Vertical;

                // Позиционирование кнопок
                buttonNoAnswer.SetBounds(12, 215, 110, 23); // Слева
                buttonOk.SetBounds(230, 215, 75, 23);
                buttonCancel.SetBounds(311, 215, 75, 23);

                // Логика кнопки "Не дозвонился"
                buttonNoAnswer.Click += (sender, e) => 
                {
                    textBox.Text = "Не дозвонился";
                    form.DialogResult = DialogResult.OK;
                    form.Close();
                };

                form.Controls.AddRange(new Control[] { label, datePicker, textBox, buttonNoAnswer, buttonOk, buttonCancel });
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.MaximizeBox = false;
                form.MinimizeBox = false;

                if (form.ShowDialog() == DialogResult.OK)
                {
                    return new InputResult 
                    { 
                        Comment = textBox.Text, 
                        SelectedDate = datePicker.Value 
                    };
                }
                else return null;
            }
        }
    }

    private static void SendMessage(IUserSession scriptSession, long objectID, string caption, string messageText)
    {
        IForumsService forumService = scriptSession.GetCustomService(typeof(IForumsService)) as IForumsService;
        if (forumService == null) throw new Exception("IForumsService not found");
        var fSvc = ServicesManager.GetService(typeof(IFiltrationService)) as IFiltrationService;
        ICurrentUserAndRole cc = ServicesManager.GetService(typeof(ICurrentUserAndRole)) as ICurrentUserAndRole;
        var obj = scriptSession.GetObject(objectID);
        var forum = forumService.GenerationForum(objectID, obj.ID, ForumFormat.Version, fSvc.FiltrationServiceOwnerID, scriptSession.SessionGUID);
        
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

    private static List<int> Load(ICompositionLoadService compositionLoadService, IUserSession scriptSession, int objId, int objTypeId, List<int> searchRelationTypes, List<int> searchObjectType, bool composition, ConditionStructure[] conds)
    {
        var idList = new List<int>();
        if (compositionLoadService == null) return idList;
        DataTable parentTable = compositionLoadService.LoadComposition(scriptSession, objId, objTypeId, searchRelationTypes, searchObjectType, new List<ColumnDescriptor> { new ColumnDescriptor((int)ObligatoryObjectAttributes.F_OBJECT_ID, AttributeSourceTypes.Object, ColumnContents.Text, ColumnNameMapping.FieldName, SortOrders.NONE, 0) }, composition, false, null, conds ?? new ConditionStructure[] { }, SystemGUIDs.filtrationAllVersions, null, -1);
        if (parentTable == null) return idList;
        foreach (DataRow row in parentTable.Rows)
        {
            int id;
            if (int.TryParse(row[Consts.F_OBJECT_ID].ToString(), out id)) idList.Add(id);
        }
        return idList;
    }
}