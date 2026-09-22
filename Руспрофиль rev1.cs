using System;
using System.ComponentModel.Design;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;

public class Script
{
    public ICSharpScriptContext ScriptContext { get; private set; }
    public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
    {
        #region Настройки

        // GUID атрибута содержащий ИНН организации (вставить свой GUID)
        const string ATTRIBUTE_GUID = "f72b99e7-9f88-46a2-b020-8b6657ca1313" /*ИНН*/;

        #endregion

        // пользовательская сессия
        IUserSession session = parameters.UserSession;
        // объект с формой
        IDBObject obj = session.GetObject(parameters.ObjectID);
        // получаем атрибут содержащий ИНН
        IDBAttribute attrINN = obj.GetAttributeByGuid(new Guid(ATTRIBUTE_GUID));
        try
        {
            // проверяем атрибут на наличие и непустое значение
            if (attrINN == null || attrINN.IsNull)
                throw new Exception("ИНН не заполнен. Заполните ИНН организации");

            // Value может прийти как строка или как число. Если атрибут числовой,
            // ToString() под русской локалью может вставить пробелы-разделители разрядов
            // (например "5 259 077 666") — именно из-за этого итоговый URL оказывался
            // "битым" и rusprofile отвечал 404. Поэтому оставляем только цифры.
            string rawValue = attrINN.Value.ToString();
            string inn = Regex.Replace(rawValue, @"[^\d]", "");

            if (string.IsNullOrEmpty(inn))
                throw new Exception(string.Format("Значение ИНН имеет неверный формат: '{0}'", rawValue));

            if (inn.Length != 10 && inn.Length != 12)
                throw new Exception(string.Format("ИНН должен содержать 10 или 12 цифр, а получено {0}: '{1}'", inn.Length, inn));

            // Формируем адрес ссылки, например: https://www.rusprofile.ru/search?query=5259077666&type=ul
            // Значение дополнительно кодируем через Uri.EscapeDataString на случай спецсимволов
            string urlAdress = "https://www.rusprofile.ru/search?query=" + Uri.EscapeDataString(inn) + "&type=ul";

            // получаем URL адрес ссылки
            Uri url = new Uri(urlAdress);

            // проверяем формат ссылки
            if (url.Scheme != "http" && url.Scheme != "https")
                throw new Exception(string.Format("Недопустимый URL адрес: '{0}'", url.OriginalString));

            // открываем ссылку в браузере
            System.Diagnostics.Process.Start(url.OriginalString);
        }
        catch (Exception e)
        {
            // если возникла ошибка при открытии URL адреса показываем сообщение пользователю
            MessageBox.Show(string.Format("Не удалось открыть ссылку.{0}", Environment.NewLine + e.Message), "Предупреждение");
        }
        return parameters;
    }
}