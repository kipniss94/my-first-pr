using System;
using System.IO;
using System.Xml;
using System.Data;
using System.Linq;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.ComponentModel;
using System.Windows.Forms;
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
        DocumentTreeNode mainTable = document.FindFirstNodeFromTemplate_Recursive("Рабочая область");
        if(mainTable == null)
        {
            throw new Exception("В шаблоне не найдена Рабочая область");
        }
        List<long> allZadId = new List<long>();
        List<ZadachaClass> allZadList = new List<ZadachaClass>();
        foreach(Int64 proectId in objectIDs)
        {
            ProjectClass projectData = ProjectData(session, proectId);
            if(projectData != null)
            {                
                List<ZadachaClass> zadList = ZadachaCompositions(session, proectId, 1578);
                if(!IsNullOrEmpty(zadList))
                {
                    int countZadach = zadList.Count;
                    for(int i = 0; i < countZadach; i++)
                    {
                        List<UserClass> userList =  UserCompositions(session, zadList[i].Id, 1577);
                        if(!IsNullOrEmpty(userList))
                        {
                            string usersStr = userList[0].Caption;
                            zadList[i].UserName = usersStr;
                        }
                        if(!allZadId.Contains(zadList[i].Id))
                        {
                            allZadId.Add(zadList[i].Id);
                            allZadList.Add(zadList[i]);
                        }
                    }
                }
            }
        }
        if(IsNullOrEmpty(allZadList))
        {
            throw new Exception("Задачи не обнаружены");
        }
        allZadList.Sort(ZadachSortByUserName);
        string toUserName = string.Empty;
        DocumentTreeNode userRow = null;
        DocumentTreeNode izdSubRow = null;
        foreach(ZadachaClass zadachaData in allZadList)
        {
            if(IsNullOrEmpty(zadachaData.UserName))
            {
                continue;
            }
            //DocumentTreeNode imProcRow = document.Template.FindNode("Проекты строка").CloneFromTemplate(true, true);
            //mainTable.AddChildNode(imProcRow, false, false);
            if(toUserName != zadachaData.UserName)
            {
                toUserName = zadachaData.UserName;
                userRow = document.Template.FindNode("Проекты строка").CloneFromTemplate(true, true);
                mainTable.AddChildNode(userRow, false, false);
                WritingCell(userRow, "Инженер конструктор", toUserName);
                izdSubRow = userRow;
            }
            else
            {
                DocumentTreeNode izdSubSubTable = userRow.FindFirstChildNodeByName("Изделие таблица");
                //Строка из подТаблицы
                izdSubRow = izdSubSubTable.FindNode("Изделие подСтрока").CloneFromTemplate(true, true);
                izdSubSubTable.AddChildNode(izdSubRow, false, false);
            }
            //Список изделий прекреплённые к задаче
            List<DseClass> dseProces = DseCompositions(session, zadachaData.Id, 1577);
            if(!IsNullOrEmpty(dseProces))
            {
                StringBuilder dseStr = new StringBuilder();
                foreach(DseClass dseData in dseProces)
                {
                    dseStr.Append(dseData.Designation + " " + dseData.Name + "; ");
                }
                WritingCell(izdSubRow, "Изделие", dseStr.ToString());
            }
            if(zadachaData.FinishFakt > DateTime.MinValue)
            {
                double countMinuteFact = CountWorkMinuteByStartAndDate(zadachaData.StartFakt, zadachaData.FinishFakt);
                double countHourFact = Math.Ceiling(countMinuteFact / 60.0);
                //double countMinutePlan = CountWorkMinuteByStartAndDate(zadachaData.StartPlan, zadachaData.FinishPlan);
                //double countHourPlan = Math.Ceiling(countMinutePlan / 60.0);
                double countHourPlan = zadachaData.LadorPlan;
                double countMinutePlan = countHourPlan * 60.0;
                //WritingCell(izdSubRow, "Время выполн", zadachaData.StartPlan.ToString("dd-MM-yy H.m") +" "+ zadachaData.FinishPlan.ToString("dd-MM-yy H.m") +" >"+ countMinutePlan.ToString());
                WritingCell(izdSubRow, "Время выполн", countHourPlan.ToString());
                double countVnePlanMinute = countMinuteFact - countMinutePlan;
                double countVnePlanHour = Math.Ceiling(countVnePlanMinute / 60.0);
                //WritingCell(izdSubRow, "Время вне плана", countMinuteFact.ToString() +"-"+ countMinutePlan.ToString() +"="+ countVnePlanMinute.ToString());
                WritingCell(izdSubRow, "Время вне плана", countVnePlanHour.ToString());
            }
        }
        mainTable.UpdateLayout(true);
    }
    
    //Сортировка список задач по полю тип продукции
    private int ZadachSortByUserName(ZadachaClass x, ZadachaClass y)
    {
        if(IsNullOrEmpty(x.UserName))
        {
            return 1;
        }
        else if(IsNullOrEmpty(y.UserName))
        {
            return -1;
        }
        else
        {
            return x.UserName.CompareTo(y.UserName);
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
            DateTime endControlDT = new DateTime(EndDT.Year, EndDT.Month, EndDT.Day - 1);
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
                if(period.StartHours <= Hour)
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
        if(calendarDay.DayType == DayType.Holyday)
        {
            _dayPeriods[dtHash] = null;
            return null;
        }
        IReadOnlyList<IWorkTimePeriod> workPeriods = calendarDay.WorkTimePeriods;
        _dayPeriods[dtHash] = workPeriods;
        return workPeriods;
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
    public ProjectClass ProjectData(IUserSession session, long ObjectId)
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
        ProjectClass result = new ProjectClass();
        result.Id = objectIDB.ObjectID;
        result.Caption = objectIDB.Caption;
        result.Create = objectIDB.CreateDate;
        //Начато
        IDBAttribute startPlanAttr = objectIDB.GetAttributeByID(1303);
        if(startPlanAttr != null)
        {
            result.StartPlan = startPlanAttr.AsDateTime;
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
            result.LadorPlan = ladorPlanAttr.AsDouble;
            //MessageBox.Show(ladorPlanAttr.AsDouble.ToString());
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
    //Информация о Задачах (Ресурсы задачи)
    public List<ZadachaClass> ZadachaCompositions(IUserSession session, long ObjectId, int ObjTypeId, int loadLevels = -1)
    {
        // Список колонок для поиска
        ColumnDescriptor[] columns = ZadachaReguredAttributs();
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
                Caption = Obj2StringOrEmty(TableRow["cad00047-306c-11d8-b4e9-00304f19f545"]),
                StartFakt = ToDateTime(TableRow["cad015d9-306c-11d8-b4e9-00304f19f545"]),
                FinishFakt = ToDateTime(TableRow["cad015da-306c-11d8-b4e9-00304f19f545"]),
                StartPlan = ToDateTime(TableRow["cad002cb-306c-11d8-b4e9-00304f19f545"]),
                FinishPlan = ToDateTime(TableRow["cad0132d-306c-11d8-b4e9-00304f19f545"]),
                LadorPlan = ToDuoble(TableRow["cad00e97-306c-11d8-b4e9-00304f19f545"])
            };
            result.Add(newDocData);
        }
        return result;
    }
    //Список атрибутов для Оснастки
    public ColumnDescriptor[] ZadachaReguredAttributs()
    {
        ColumnNameMapping columnNameMapping = ColumnNameMapping.Guid;
        // Создаём список атрибутов
        ColumnDescriptor[] columns = new ColumnDescriptor[]
        {
            // Идентификатор версии объекта cad00029-306c-11d8-b4e9-00304f19f545
            new ColumnDescriptor(-2, AttributeSourceTypes.Object, ColumnContents.ID, columnNameMapping, SortOrders.NONE, -1),
            // Заголовок объекта
            new ColumnDescriptor(-50, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
            // Фактическое начало
            new ColumnDescriptor(15231, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
            // Фактическое окончание
            new ColumnDescriptor(15232, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
            // Начато
            new ColumnDescriptor(1303, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
            // Срок выполнения
            new ColumnDescriptor(1321, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
            // Трудозатраты
            new ColumnDescriptor(15237, AttributeSourceTypes.Object, ColumnContents.Text, columnNameMapping, SortOrders.NONE, -1),
        };
        return columns;
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
    
    public DateTime ToDateTime(object Value)
    {
        if(Value == null)
        {
            return DateTime.MinValue;
        }
        return ToDateTime(Convert.ToString(Value));
    }
    
    public DateTime ToDateTime(string Value)
    {
        if(Value == null)
        {
            return DateTime.MinValue;
        }
        if(Value == "")
        {
            return DateTime.MinValue;
        }
        if(Value.Length < 5)
        {
            return DateTime.MinValue;
        }
        DateTime result;
        if(DateTime.TryParse(Value, out result))
        {
            return result;
        }
        return DateTime.MinValue;
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
    //Фактическое начала
    public DateTime StartFakt;
    //Начато
    public DateTime StartPlan;
    //Фактическое окончание
    public DateTime FinishFakt;
    //Срок выполнения
    public DateTime FinishPlan;
    //Трудозатраты в сек
    public double LadorPlan;
    //Исполнитель
    public string UserName;
}
//Данные Пректа
public class ProjectClass
{
    //Идентификатор ДСЕ
    public long Id;
    //Заголовок
    public string Caption;
    //Начато
    public DateTime StartPlan;
    //Срок выполнения
    public DateTime FinishPlan;
    //Трудозатраты в сек
    public double LadorPlan;
    //Дата создания
    public DateTime Create;
}