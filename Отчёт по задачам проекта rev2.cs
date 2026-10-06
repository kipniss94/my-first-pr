using System;
using System.IO;
using System.Xml;
using System.Data;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Text;
using Intermech;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;
using Intermech.Interfaces.Document;
using Intermech.Interfaces.Compositions;
using Intermech.Interfaces.PdmConfigurator;
using Intermech.Interfaces.Calendars;
using Intermech.Expert.Scenarios;
using Intermech.Kernel.Search;
public class Script
{
    public ICSharpScriptContext ScriptContext { get; set; }
    
    // Тип объекта «Задача»
    private const int TaskTypeId = 1577;
    
    public ScriptResult Execute(IUserSession session, ImDocumentData document, Int64[] objectIDs)
    {
        if(IsNullOrEmpty(objectIDs))
        {
            throw new Exception("Список задач пуст");
        }
        //ZadachData(session, objectIDs[0]);
        GenarateFirstPage(session, document, objectIDs);
        return new ScriptResult(true, document);
    }
    
    public void GenarateFirstPage(IUserSession session, ImDocumentData document, Int64[] objectIDs)
    {
        CalendarsStart(session);
        // Отчёт выполняется на сервере приложений: окна редактора проекта
        // (активный проект, фильтр задач) там нет, поэтому задачи берутся из БД.
        // Запуск на задачах — в отчёт попадают выбранные задачи,
        // запуск на проекте — все задачи проекта.
        List<long> procIds = new List<long>();
        foreach(Int64 objId in objectIDs)
        {
            IDBObject selected = session.GetObject(objId);
            if(selected == null)
            {
                continue;
            }
            if(selected.ObjectType == TaskTypeId)
            {
                if(!procIds.Contains(selected.ObjectID))
                {
                    procIds.Add(selected.ObjectID);
                }
                continue;
            }
            List<ZadachaClass> zadList = ZadachaCompositions(session, objId, selected.ObjectType);
            if(!IsNullOrEmpty(zadList))
            {
                foreach(ZadachaClass zaData in zadList)
                {
                    if(!procIds.Contains(zaData.Id))
                    {
                        procIds.Add(zaData.Id);
                    }
                }
            }
        }
        if(IsNullOrEmpty(procIds))
        {
            throw new Exception("Задачи не обнаружены");
        }
        //Получаем список всех выбранных задач
        List<ImProClass> allProcessList = new List<ImProClass>();
        foreach(Int64 objId in procIds)
        {
            ImProClass processData = ZadachData(session, objId);
            allProcessList.Add(processData);
        }
        //Сортируем список задач по полю тип продукции
        allProcessList.Sort(ZadachSortByProduktType);
        
        DocumentTreeNode mainTable = document.FindFirstNodeFromTemplate_Recursive("Рабочая область");
        if(mainTable == null)
        {
            throw new Exception("В шаблоне не найдена Рабочая область");
        }
        double countWorkMinute = 0;
        double countHour = 0;
        string prodType = string.Empty;
        //string prodType = allProcessList[0].ProduktType;
        int countImProc = allProcessList.Count;
        DocumentTreeNode imProcRow = null;
        DocumentTreeNode procSubRow = null;
        for(int i = 0; i < countImProc; i++)
        {
            if(prodType != allProcessList[i].ProduktType)
            {
                prodType = allProcessList[i].ProduktType;
                if(IsNullOrEmpty(prodType))
                {
                    prodType = "";
                }
                imProcRow = document.Template.FindNode("Проекты строка").CloneFromTemplate(true, true);
                mainTable.AddChildNode(imProcRow, false, false);
                WritingCell(imProcRow, "Наименование группы изд", prodType);
                procSubRow = imProcRow;
            }
            else
            {
                //Загрузка подТаблицы
                DocumentTreeNode imProcSubTable = imProcRow.FindFirstChildNodeByName("Прпоект подтаблица");
                //Строка из подТаблицы
                procSubRow = imProcSubTable.FindNode("Изделие подСтрока").CloneFromTemplate(true, true);
                imProcSubTable.AddChildNode(procSubRow, false, false);
            }
            if(allProcessList[i].StartFakt > DateTime.MinValue)
            {
                WritingCell(procSubRow, "Старт проект", allProcessList[i].StartFakt.ToString("dd-MM-yyyy"));//allProcessList[i].FinishFakt
                if(allProcessList[i].FinishFakt > DateTime.MinValue)
                {
                    WritingCell(procSubRow, "Завершение проект", allProcessList[i].FinishFakt.ToString("dd-MM-yyyy"));
                    countWorkMinute = CountWorkMinuteByStartAndDate(allProcessList[i].StartFakt, allProcessList[i].FinishFakt);
                    countHour = Math.Ceiling(countWorkMinute / 60.0);//Округляем вверх
                    WritingCell(procSubRow, "Время проект", countHour.ToString());
                }
            }
            //Список изделий прекреплённые к задаче
            List<DseClass> dseProces = DseCompositions(session, allProcessList[i].Id, 1577);
            if(!IsNullOrEmpty(dseProces))
            {
                StringBuilder dseStr = new StringBuilder();
                foreach(DseClass dseData in dseProces)
                {
                    dseStr.Append(dseData.Designation + " " + dseData.Name + "; ");
                }
                WritingCell(procSubRow, "Наименование изд", dseStr.ToString());
            }
            List<UserClass> userList =  UserCompositions(session, allProcessList[i].Id, 1577);
            if(!IsNullOrEmpty(userList))
            {
                StringBuilder userStr = new StringBuilder();
                foreach(UserClass userData in userList)
                {
                    userStr.Append(userData.Caption + "; ");
                }
                WritingCell(procSubRow, "ФИО", userStr.ToString());
            }
        }
        mainTable.UpdateLayout(true);
    }
    //Сортировка список задач по полю тип продукции
    private int ZadachSortByProduktType(ImProClass x, ImProClass y)
    {
        if(IsNullOrEmpty(x.ProduktType))
        {
            return 1;
        }
        else if(IsNullOrEmpty(y.ProduktType))
        {
            return -1;
        }
        else
        {
            return x.ProduktType.CompareTo(y.ProduktType);
        }
    }
    private double CountWorkMinuteByStartAndDate(DateTime StartDT, DateTime EndDT)
    {
        if((EndDT - StartDT).TotalDays > 0.5)
        {
            //MessageBox.Show((EndDT - StartDT).TotalDays.ToString());
            double resultMinute = 0;
            resultMinute = CountWorkMinute(StartDT.Year, StartDT.Month, StartDT.Day, StartDT.Hour, StartDT.Minute);
            resultMinute = resultMinute + CountWorkMinuteEnd(EndDT.Year, EndDT.Month, EndDT.Day, EndDT.Hour, EndDT.Minute);
            DateTime endControlDT = EndDT.Date.AddDays(-1);
            DateTime nextDT = StartDT;
            while(nextDT < endControlDT)
            {
                nextDT = nextDT.AddDays(1);
                resultMinute = resultMinute + CountWorkMinute(nextDT.Year, nextDT.Month, nextDT.Day, 0);
            }
            return resultMinute;
        }
        else
        {
            double resultMinute = (EndDT - StartDT).TotalMinutes;
            //MessageBox.Show(resultMinute.ToString());
            return resultMinute;
        }
    }
    private ICalendar calendar = null;
    private void CalendarsStart(IUserSession session)
    {
        ICalendarsService calendatService = ApplicationServices.Container.GetService(typeof(ICalendarsService)) as ICalendarsService;
        calendar = calendatService.GetCalendar(session, 895666);
    }
    private double CountWorkMinuteEnd(int Year, int Month, int Day, int Hour, int Minute = 0, int Second = 0)
    {
        //IReadOnlyList<IWorkTimePeriod> workPeriods = calendarDay.WorkTimePeriods;
        IReadOnlyList<IWorkTimePeriod> workPeriods = DayPeriods(Year, Month, Day);
        if(!IsNullOrEmpty(workPeriods))
        {
            double countMinut = 0D;
            foreach(IWorkTimePeriod period in workPeriods)
            {
                if(period.FinishHours <= Hour)
                {
                    countMinut = countMinut + ((period.FinishHours - period.StartHours) * 60.0);
                }
                else
                {
                    countMinut = (countMinut + ((Hour - period.StartHours) * 60.0));
                }
                countMinut = countMinut - period.StartMinutes;
            }
            return countMinut;
        }
        return 0D;
    }
    private  Dictionary<int, IReadOnlyList<IWorkTimePeriod>> _dayPeriods = new Dictionary<int, IReadOnlyList<IWorkTimePeriod>>();
    private IReadOnlyList<IWorkTimePeriod> DayPeriods(int Year, int Month, int Day)
    {
        int dtHash = (int)((Year * 10000) + (Month * 100) + Day);
        if(_dayPeriods.ContainsKey(dtHash))
        {
            return _dayPeriods[dtHash];
        }
        DateTime toDay = new DateTime(Year, Month, Day);
        ICalendarDay calendarDay = calendar.GetDayByDate(toDay);
        if(calendarDay == null || IsNonWorkingDay(calendarDay))
        {
            _dayPeriods[dtHash] = null;
            return null;
        }
        IReadOnlyList<IWorkTimePeriod> workPeriods = calendarDay.WorkTimePeriods;
        _dayPeriods[dtHash] = workPeriods;
        return workPeriods;
    }
    
    //Нерабочий день календаря (праздник, выходной).
    //Имя значения DayType отличается в разных версиях IPS (Holyday, Holiday...),
    //поэтому тип дня сравнивается по имени: так скрипт компилируется в любой версии.
    //День без рабочих периодов тоже считается нерабочим.
    private bool IsNonWorkingDay(ICalendarDay calendarDay)
    {
        string dayType = Convert.ToString(calendarDay.DayType);
        string[] nonWorkingNames = new string[] { "Holiday", "Holyday", "Weekend", "DayOff", "NonWorking", "NotWorking", "Free", "Rest", "Off" };
        foreach(string name in nonWorkingNames)
        {
            if(string.Equals(dayType, name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return IsNullOrEmpty(calendarDay.WorkTimePeriods);
    }
    
    //private Dictionary<int, int> _countWorkMinute = new Dictionary<int, int>();
    private double CountWorkMinute(int Year, int Month, int Day, int Hour, int Minute = 0, int Second = 0)
    {
        //IReadOnlyList<IWorkTimePeriod> workPeriods = calendarDay.WorkTimePeriods;
        IReadOnlyList<IWorkTimePeriod> workPeriods = DayPeriods(Year, Month, Day);
        if(!IsNullOrEmpty(workPeriods))
        {
            double countLeftMinut = 0D;
            foreach(IWorkTimePeriod period in workPeriods)
            {
                if(period.FinishHours > Hour)
                {
                    if(Hour > period.StartHours)
                    {
                        countLeftMinut = (countLeftMinut + ((period.FinishHours - Hour)*60));
                        countLeftMinut = (countLeftMinut - Minute + period.FinishMinutes);
                    }
                    else
                    {
                        countLeftMinut = (countLeftMinut + ((period.FinishHours - period.StartHours)*60));
                        countLeftMinut = (countLeftMinut + period.FinishMinutes - period.StartMinutes);
                    }
                }
            }
            //_countWorkMinute[dtHash] = countLeftMinut;
            return countLeftMinut;
        }
        //_countWorkMinute[dtHash] = 0;
        return 0D;
    }
    //Запись значения в ячейку таблицы
    private void WritingCell(DocumentTreeNode docRow, string CellName, object CellValue)
    {
        if(!IsNullOrEmpty(CellValue))
        {
            ScenarioFunc.WriteNodeRow(docRow, CellName, CellValue.ToString());
        }
    }
    //Заполнение поля документа
    private void WriteDocTextPole(ImDocumentData document, string FieldName, IDBAttribute AttributeValue)
    {
        if(AttributeValue == null)
        {
            return;
        }    	
        WriteDocTextPole(document, FieldName, AttributeValue.AsString);
    }
    //Заполнение поля документа
    private void WriteDocTextPole(ImDocumentData document, string FieldName, double? Value)
    {
        if(IsNullOrEmpty(Value))
        {
            return;
        }
        WriteDocTextPole(document, FieldName, Value.Value.ToString());
    }
    //Заполнение поля документа
    private void WriteDocTextPole(ImDocumentData document, string FieldName, string Value)
    {
        if(IsNullOrEmpty(FieldName))
        {
            throw new Exception("Не задано наименованние поля в шаблоне");
        }
        if(IsNullOrEmpty(Value))
        {
            return;
        }
        TextData fieldText = document.FindFirstNodeFromTemplate_Recursive(FieldName) as TextData;
        if(fieldText != null)
        {
            fieldText.AssignText(Value, false, false, false);
        }
        else
        {
            throw new Exception("В шаблоне нет поля "+ FieldName);
        }
    }
    public ImProClass ZadachData(IUserSession session, long ObjectId)
    {
        if(ObjectId == 0)
        {
            return null;
        }
        if(session == null)
        {
            return null;
        }    	
        IDBObject objectIDB = session.GetObject(ObjectId);
        if(objectIDB == null)
        {
            return null;
        }
        ImProClass result = new ImProClass();
        result.Id = objectIDB.ObjectID;
        result.Caption = objectIDB.Caption;
        //Фактическое начало
        IDBAttribute startFaktAttr = objectIDB.GetAttributeByID(15231);
        if(startFaktAttr != null)
        {
            result.StartFakt = startFaktAttr.AsDateTime;
        }
        //Начато
        IDBAttribute startPlanAttr = objectIDB.GetAttributeByID(1303);
        if(startPlanAttr != null)
        {
            result.StartPlan = startPlanAttr.AsDateTime;
        }
        //Фактическое окончание
        IDBAttribute finishFaktAttr = objectIDB.GetAttributeByID(15232);
        if(finishFaktAttr != null)
        {
            result.FinishFakt = finishFaktAttr.AsDateTime;
        }
        //Срок выполнения
        IDBAttribute finishPlanAttr = objectIDB.GetAttributeByID(1321);
        if(finishPlanAttr != null)
        {
            result.FinishPlan = finishPlanAttr.AsDateTime;
        }
        //Трудозатраты в сек
        IDBAttribute ladorPlanAttr = objectIDB.GetAttributeByID(15237);
        if(ladorPlanAttr != null)
        {
            result.Lador = ladorPlanAttr.AsDouble;
            //MessageBox.Show(ladorPlanAttr.AsDouble.ToString());
        }
        //Тип продукции
        IDBAttribute productTypeAttr = objectIDB.GetAttributeByID(18716);
        if(productTypeAttr != null)
        {
            result.ProduktType = productTypeAttr.AsString;
        }
        return result;
    }
    //Информация о Результате задачи
    public List<DseClass> DseCompositions(IUserSession session, long ObjectId, int ObjTypeId, int loadLevels = 1)
    {
        // Список колонок для поиска
        ColumnDescriptor[] columns = DseReguredAttributs();
        // Список эксплуатационных документов на изделие поиск вниз
        List<int> objTypes = new List<int> { 1052, 1074, 1138, 1853, 1751 }; //1052-Детали; 1074-Сборочные единицы; 1138-Прочие изделия; 1853-Специальная технологическая оснастка (деталь); 1751-Специальная технологическая оснастка
        List<int> objRelation = new List<int> { 1032 };//1032 - Вложения ImProject
        DataTable composition = ObjectsComposition(session, ObjectId, ObjTypeId, columns, objTypes, objRelation, loadLevels, true);
        if(IsNullOrEmpty(composition))
        {
            return null; //Если список пуст то выводим null
        }
        List<DseClass> result = new List<DseClass>();
        foreach (DataRow TableRow in composition.Rows)
        {
            DseClass newDocData = new DseClass()
            {
                Id = ToLong(TableRow["cad00029-306c-11d8-b4e9-00304f19f545"]),
                Designation = Obj2StringOrEmty(TableRow["cad0001f-306c-11d8-b4e9-00304f19f545"]),
                Name = Obj2StringOrEmty(TableRow["cad00020-306c-11d8-b4e9-00304f19f545"]),
                TypeId = ToInt(TableRow["cad0002e-306c-11d8-b4e9-00304f19f545"])
            };
            result.Add(newDocData);
        }
        return result;
    }
    //Список атрибутов для Оснастки
    public ColumnDescriptor[] DseReguredAttributs()
    {
        ColumnNameMapping columnNameMapping = ColumnNameMapping.Guid;
        // Создаём список атрибутов
        ColumnDescriptor[] columns = new ColumnDescriptor[]
        {
            // Идентификатор версии объекта cad00029-306c-11d8-b4e9-00304f19f545
            new ColumnDescriptor(-2, AttributeSourceTypes.Object, ColumnContents.ID, columnNameMapping, SortOrders.NONE, -1),
            // Наименование
            new ColumnDescriptor(10, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.ASC, 1),
            // Обозначение cad0001f-306c-11d8-b4e9-00304f19f545
            new ColumnDescriptor(9, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
            // Тип объекта -7 cad0002e-306c-11d8-b4e9-00304f19f545
            new ColumnDescriptor(-7, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
        };
        return columns;
    }
    //Информация о Пользователях (Ресурсы задачи)
    public List<ZadachaClass> ZadachaCompositions(IUserSession session, long ObjectId, int ObjTypeId, int loadLevels = -1)
    {
        // Список колонок для поиска
        ColumnDescriptor[] columns = UserReguredAttributs();
        // Список эксплуатационных документов на изделие поиск вниз
        List<int> objTypes = new List<int> { 1577 };
        List<int> objRelation = new List<int> { 1027 };
        DataTable composition = ObjectsComposition(session, ObjectId, ObjTypeId, columns, objTypes, objRelation, loadLevels, true);
        if(IsNullOrEmpty(composition))
        {
            return null; //Если список пуст то выводим null
        }
        List<ZadachaClass> result = new List<ZadachaClass>();
        foreach (DataRow TableRow in composition.Rows)
        {
            ZadachaClass newDocData = new ZadachaClass()
            {
                Id = ToLong(TableRow["cad00029-306c-11d8-b4e9-00304f19f545"]),
                Caption = Obj2StringOrEmty(TableRow["cad00047-306c-11d8-b4e9-00304f19f545"])
            };
            result.Add(newDocData);
        }
        return result;
    }
    //Информация о Пользователях (Ресурсы задачи)
    public List<UserClass> UserCompositions(IUserSession session, long ObjectId, int ObjTypeId, int loadLevels = 1)
    {
        // Список колонок для поиска
        ColumnDescriptor[] columns = UserReguredAttributs();
        // Список эксплуатационных документов на изделие поиск вниз
        List<int> objTypes = new List<int> { 1 }; //1 - Пользователи
        List<int> objRelation = new List<int> { 1026 };//1026 - Ресурс ImProject
        DataTable composition = ObjectsComposition(session, ObjectId, ObjTypeId, columns, objTypes, objRelation, loadLevels, true);
        if(IsNullOrEmpty(composition))
        {
            return null; //Если список пуст то выводим null
        }
        List<UserClass> result = new List<UserClass>();
        foreach (DataRow TableRow in composition.Rows)
        {
            UserClass newDocData = new UserClass()
            {
                Id = ToLong(TableRow["cad00029-306c-11d8-b4e9-00304f19f545"]),
                Caption = Obj2StringOrEmty(TableRow["cad00047-306c-11d8-b4e9-00304f19f545"])
            };
            result.Add(newDocData);
        }
        return result;
    }
    //Список атрибутов для Оснастки
    public ColumnDescriptor[] UserReguredAttributs()
    {
        ColumnNameMapping columnNameMapping = ColumnNameMapping.Guid;
        // Создаём список атрибутов
        ColumnDescriptor[] columns = new ColumnDescriptor[]
        {
            // Идентификатор версии объекта cad00029-306c-11d8-b4e9-00304f19f545
            new ColumnDescriptor(-2, AttributeSourceTypes.Object, ColumnContents.ID, columnNameMapping, SortOrders.NONE, -1),
            // Заголовок объекта
            new ColumnDescriptor(-50, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.ASC, 1)
        };
        return columns;
    }
    /// <summary>
    /// Формирование таблицы состава объекта
    /// </summary>
    /// <param name="ObjectId">Идентификатор объекта</param>
    /// <param name="ObjectType">Тип объекта</param>
    /// <param name="AtributesSet">Набор атрибутов</param>
    /// <param name="RelationTypeSet">Типы связей по которому происходит поиск</param>
    /// <param name="ObjectTypeSet">Типы искомых объектов</param>
    /// <param name="loadLevels">Количество уровней раскрытия. -1 неограниченое количество уровней</param>
    public DataTable ObjectsComposition(IUserSession session, Int64 ObjectId, Int32 ObjectType, IEnumerable<ColumnDescriptor> AtributesSet, IEnumerable<int> ObjectTypeSet, IEnumerable<int> RelationTypeSet, int loadLevels, bool Composition = true)
    {
        if(session == null)
        {
            throw new Exception("Сессия пользователя неактивна! session = null");
        }
        
        if (IsNullOrEmpty(ObjectTypeSet))
        {
            throw new Exception("Список типов искомых объектов пуст! Обратитесь администраторам");
        }
        
        if (IsNullOrEmpty(RelationTypeSet))
        {
            throw new Exception("Список типов связей поиска пуст! Обратитесь администраторам");
        }
        
        if (IsNullOrEmpty(AtributesSet))
        {
            throw new Exception("Список полей пуст! Обратитесь администраторам");
        }
        // Пробуем получить у сессии ссылку на службу, упрощающую чтение составов
        ICompositionLoadService svc = session.GetCustomService(typeof(ICompositionLoadService)) as ICompositionLoadService;
        if (svc == null)
        {
            throw new Exception("Сервис работы с составом не доступен! Обратитесь администраторам");
        }
        // Получаем настройки фильтрации составов в текущем окне
        /*
        IFiltrationService fSvc = ServicesManager.GetService(typeof(IFiltrationService)) as IFiltrationService;
        if (fSvc == null)
        {
            throw new Exception("Настройка фильтрации не доступна! Обратитесь администраторам");
        }
        */
        // В составе показываем актуальные заменители
        HybridDictionary tags = new HybridDictionary(1);
        tags[PDMPluginGuids.buttonSubstitutesGuid] = true;
        // Получаем состав (согласно текущим настройкам фильтрации)
        // Таблица с составом fSvc.FiltrationServiceOwnerID
        //DataTable composition = svc.LoadComposition(session.SessionGUID, ObjectId, ObjectType, RelationTypeSet, ObjectTypeSet, AtributesSet, Composition, false, null, null, fSvc.Filtration.OwnerID, tags, loadLevels);
        DataTable composition = svc.LoadComposition(session.SessionGUID, ObjectId, ObjectType, RelationTypeSet, ObjectTypeSet, AtributesSet, Composition, false, null, null, null, tags, loadLevels);
        return composition;
    }
    //Преобразование входных данных в вещественное число
    private double ToDuoble(object Value)
    {
        if(Value == null)
        {
            return 0;
        }
        return ToDuoble(Convert.ToString(Value));
    }
    //Преобразование текста в вещественное число
    private double ToDuoble(string Value)
    {
        if(Value == null)
        {
            return 0;
        }
        if(Value == "")
        {
            return 0;
        }
        string[] Values = Value.Split(' ');
        double result;
        if(double.TryParse(Values[0], out result))
        {
            return result;
        }
        return 0;
    }
    //Преобразование значения в целое число
    private int ToInt(object Value)
    {
        if(Value == null)
        {
            return 0;
        }
        return ToInt(Convert.ToString(Value));
    }
    //Преобразование текста в целое число
    private int ToInt(string Value)
    {
        if(Value == null)
        {
            return 0;
        }
        if(Value == "")
        {
            return 0;
        }
        string[] Values = Value.Split(' ');
        int result;
        if(int.TryParse(Values[0], out result))
        {
            return result;
        }
        return 0;
    }
    //Преобразование значения в длинное целое число
    private long ToLong(object Value)
    {
        if(Value == null)
        {
            return 0;
        }
        return ToLong(Convert.ToString(Value));
    }
    //Преобразование текста в длинное целое число
    private long ToLong(string Value)
    {
        if(Value == null)
        {
            return 0;
        }
        if(Value == "")
        {
            return 0;
        }
        string[] Values = Value.Split(' ');
        long result;
        if(long.TryParse(Value, out result))
        {
            return result;
        }
        return 0;
    }
    //Преобразование значения в логическое значение
    private bool ToBool(object Value)
    {
        if(Value == null)
        {
            return false;
        }
        return ToBool(Convert.ToString(Value));
    }
    //Преобразование текста в логическое значение
    private bool ToBool(string Value)
    {
        //return true;
        if(Value == null)
        {
            return false;
        }
        if(Value == "")
        {
            return false;
        }
        if(Value == "0")
        {
            return false;
        }
        if(Value == "false")
        {
            return false;
        }
        if(Value == "False")
        {
            return false;
        }
        if(Value == "-")
        {
            return false;
        }
        //MessageBox.Show(Value);
        return true;
    }
    
    public string Obj2StringOrEmty(object Value, bool RemoveQuotes = true)
    {
        if (Value == null)
        {
            return "";
        }
        string StrValue = Convert.ToString(Value);
        if(IsNullOrEmpty(StrValue))
        {
            return "";
        }
        if (RemoveQuotes)
        {
            int strLengt = StrValue.Length;
            if (StrValue[0] == '\'' || StrValue[0] == '\"')
            {
                if (StrValue[strLengt - 1] == '\'' || StrValue[strLengt - 1] == '\"')
                {
                    StrValue = StrValue.Remove(strLengt - 1, 1);
                }
                StrValue = StrValue.Remove(0, 1);
            }
        }
        return StrValue;
    }
    /// <summary>
    /// Проверка на отсутсвие значений или на null
    /// </summary>
    /// <param name="Value">Проверяёмый параметр</param>
    public bool IsNullOrEmpty(String Value)
    {
        if (Value == null) return true;
        if (Value.Length == 0) return true;
        return false;
    }
    /// <summary>
    /// Проверка на отсутсвие значений или на null
    /// </summary>
    /// <param name="Value">Проверяёмый параметр</param>
    public bool IsNullOrEmpty(object Value)
    {
        if (Value == null) return true;
        if (Value.ToString().Length == 0) return true;
        return false;
    }
    /// <summary>Проверка на отсутсвие значений или на null</summary>
    /// <param name="Value">Проверяёмый параметр</param>
    public bool IsNullOrEmpty<T>(T[] Value)
    {
        if (Value == null) return true;
        if (Value.Length == 0) return true;
        if (Value[0] == null) return true;
        return false;
    }
    /// <summary>
    /// Проверка на отсутсвие значений или на null
    /// </summary>
    /// <param name="Value">Проверяёмый параметр</param>
    public bool IsNullOrEmpty<T>(List<T> Value)
    {
        if (Value == null) return true;
        if (Value.Count == 0) return true;
        return false;
    }
    /// <summary>Проверка на отсутсвие значений или на null</summary>
    /// <param name="Value">Проверяёмый параметр</param>
    public bool IsNullOrEmpty<T>(IEnumerable<T> Value)
    {
        if (Value == null) return true;
        if (!Value.Any()) return true;
        return false;
    }
    /// <summary>Проверка на отсутсвие значений или на null</summary>
    /// <param name="Value">Проверяёмый параметр</param>
    public bool IsNullOrEmpty(DataTable Value)
    {
        if (Value == null) return true;
        if (Value.Rows == null) return true;
        if (Value.Rows.Count < 1) return true;
        return false;
    }
    /// <summary>Проверка на отсутсвие значений или на null</summary>
    /// <param name="Value">Проверяёмый параметр</param>
    public bool IsNullOrEmpty(IDBAttribute Value)
    {
        if (Value == null) return true;
        if (Value.IsNull == null) return true;
        return IsNullOrEmpty(Value.AsString);
    }
    /// <summary>Проверка на отсутсвие значений или на null</summary>
    /// <param name="Value">Проверяёмый параметр</param>
    private bool IsNullOrEmpty(double? Months)
    {
        if(Months == null)
        {
            return true;
        }
        if(Months.Value == 0)
        {
            return true;
        }
        return false;
    }
}
/// <summary>Информация о ДСЕ (детали и сборки)</summary>
public class DseClass
{
    //Идентификатор ДСЕ
    public long Id;
    //Обозначение
    public string Designation;
    //Наименование
    public string Name;
    //Тип объекта
    public int TypeId;
}
//Данные задачи
public class ImProClass
{
    //Идентификатор ДСЕ
    public long Id;
    //Заголовок
    public string Caption;
    //Фактическое начало
    public DateTime StartFakt;
    //Начато
    public DateTime StartPlan;
    //Фактическое окончание
    public DateTime FinishFakt;
    //Срок выполнения
    public DateTime FinishPlan;
    //Трудозатраты в сек
    public double Lador;
    //Тип продукции
    public string ProduktType;
}
//Данные о пользователе
public class UserClass
{
    //Идентификатор ДСЕ
    public long Id;
    //Заголовок
    public string Caption;
}
//Данные списка задач
public class ZadachaClass
{
    //Идентификатор ДСЕ
    public long Id;
    //Заголовок
    public string Caption;
}