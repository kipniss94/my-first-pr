using System;
using System.Globalization;
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
    // пользовательская сессия
    IUserSession session = parameters.UserSession;
    
    /// Объект источник (Предприятие)****
    // объект с формой
    IDBObject obj = session.GetObject(parameters.ObjectID);
	// получаем атрибут содержащий дату начала
	IDBAttribute attrDateStart1 = obj.GetAttributeByName("Дата следующего контакта");
	if (attrDateStart1 == null)
    {
    	MessageBox.Show("Не заполнен атрибут: дата следующего контакта");
    	return parameters;
    }
	//получаем атрибут наименование (название предприятия)
	IDBAttribute attrName1 = obj.GetAttributeByName("Наименование");
	
	/// Объект получатель (Задача органайзера)****
  	// Поиск типа для создаваемого объекта (задача органайзера)
	int partObjTypeId = MetaDataHelper.GetObjectTypeIDFromName("Задачи органайзера");
	// Получаем доступ к найдиному типу
	IDBObjectCollection dBObjectCollectionPart = session.GetObjectCollection(partObjTypeId);
	// Создаём объект найденного типа
	IDBObject NewTask = dBObjectCollectionPart.Create();
	
	//Присваеваем новому объекту дату начала
	IDBAttribute attrDateStart2 = NewTask.Attributes.FindByName("Начато");
    string attrDateStart2str = String.Format("{0}", attrDateStart1.Value);
	var attrDateStart2Convert = DateTime.Parse(attrDateStart2str);
  	attrDateStart2.Value = attrDateStart2Convert.AddHours(9);
	
	//Присваеваем новому объекту дату окончания
	IDBAttribute attrDateEnd = NewTask.Attributes.FindByName("Срок выполнения");
	string attrDateEndstr = String.Format("{0}", attrDateStart1.Value);
	var attrDateEndConvert = DateTime.Parse(attrDateEndstr);
	attrDateEnd.Value = attrDateEndConvert.AddMinutes(550);
	
	//Присваеваем новому объекту "текст задачи органайзера"
	IDBAttribute attrName2 = NewTask.Attributes.FindByName("Наименование");
	attrName2.Value = "Связасться с " + attrName1.Value;
	
	//Завершаем создание объекта
	if (NewTask.IsCreationMode)
	{
    NewTask.CommitCreation(true);
	}
    return parameters;
  }
}