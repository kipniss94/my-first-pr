using System;
using System.ComponentModel.Design;
using System.Collections;
using System.Collections.Generic;
using System.Windows.Forms;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;

public class Script
{
    public ICSharpScriptContext ScriptContext { get; private set; }
    public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
    {
        #region Настройки
        
        // GUID атрибута содержащий URL адрес ссылки (вставить свой GUID)
        const string ATTRIBUTE_GUID = "cad00020-306c-11d8-b4e9-00304f19f545" /*Наименование*/ /*ИНН*/;
        
        #endregion
        
        // пользовательская сессия
        IUserSession session = parameters.UserSession;
        // объект с формой
        IDBObject obj = session.GetObject(parameters.ObjectID);
        // получаем атрибут содержащий URL адрес ссылки
        IDBAttribute attrURL = obj.GetAttributeByGuid(new Guid(ATTRIBUTE_GUID));
        try
        {
            // проверяем атрибут на наличие и непустое значение
            if (attrURL == null || attrURL.IsNull)
                throw new Exception("ИНН не заполнен. Заполните ИНН организации");
            
            // Формируем адрес ссылки https://www.rusprofile.ru/search?query=5259077666&type=ul
            String urlAdress = "https://www.rusprofile.ru/search?query="+attrURL.Value.ToString()+"&type=ul";
            
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