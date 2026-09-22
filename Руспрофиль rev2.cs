using System;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;

// ===========================================================================
// Поиск организации на rusprofile.ru по ИНН из карточки объекта.
//
// Что изменено по сравнению с rev1 (причина ошибки 404):
//
//  * Из адреса убран параметр type=ul — остался только query. Заодно в
//    адресе больше нет символа «&»: при передаче ссылки в браузер через
//    Process.Start он в некоторых настройках Windows обрезается, и это
//    давало тот же результат — «404 Страница не найдена».
//
//  * ИНН очищается от любых нецифровых символов (у числового атрибута
//    ToString() под русской локалью вставляет пробелы-разделители разрядов,
//    например «7 811 610 264») и проверяется на длину 10 или 12 цифр.
//
//  * ИНН дополнительно кладётся в буфер обмена: если сайт в очередной раз
//    поменяет адрес поиска, значение можно сразу вставить в строку поиска
//    на странице, не возвращаясь в карточку.
//
//  * ИНН читается по GUID атрибута, а если атрибут в типе объекта заведён
//    с другим GUID — по имени «ИНН».
//
// Проверять адрес запросом из скрипта бессмысленно: сайт закрыт защитой от
// роботов и на запрос не из браузера отвечает 404 даже для существующих
// страниц. Поэтому адрес просто открывается в браузере, а если сайт снова
// его поменяет — достаточно поправить строку SearchUrl ниже.
// ===========================================================================
public class Script
{
	public ICSharpScriptContext ScriptContext { get; private set; }

	#region Настройки

	// Атрибут «ИНН»
	private const string AttrInnGuid = "f72b99e7-9f88-46a2-b020-8b6657ca1313";
	private const string AttrInnName = "ИНН";

	// Адрес поиска, {0} — ИНН.
	// Запасной вариант (прежний адрес): https://www.rusprofile.ru/search?query={0}&type=ul
	private const string SearchUrl = "https://www.rusprofile.ru/search?query={0}";

	// Копировать ИНН в буфер обмена при открытии сайта
	private const bool CopyInnToClipboard = true;

	private const string DialogCaption = "Поиск организации на rusprofile.ru";

	#endregion

	public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
	{
		try
		{
			IUserSession session = parameters.UserSession;

			IDBObject obj = session.GetObject(parameters.ObjectID);
			if (obj == null)
				throw new Exception("Не удалось получить объект, с карточки которого вызван скрипт.");

			string inn = GetInn(obj);

			if (CopyInnToClipboard)
				CopyToClipboard(inn);

			OpenInBrowser(string.Format(SearchUrl, inn));
		}
		catch (Exception ex)
		{
			MessageBox.Show("Не удалось открыть ссылку." + Environment.NewLine + ex.Message,
				DialogCaption, MessageBoxButtons.OK, MessageBoxIcon.Warning);
		}

		return parameters;
	}

	// Чтение и проверка ИНН из карточки объекта
	private string GetInn(IDBObject obj)
	{
		IDBAttribute attribute = obj.GetAttributeByGuid(new Guid(AttrInnGuid));
		if (attribute == null)
			attribute = obj.Attributes.FindByName(AttrInnName);

		if (attribute == null || attribute.IsNull || attribute.Value == null)
			throw new Exception("ИНН не заполнен. Заполните ИНН организации.");

		string rawValue = attribute.Value.ToString();
		string inn = Regex.Replace(rawValue, @"[^\d]", "");

		if (inn.Length == 0)
			throw new Exception("Значение ИНН имеет неверный формат: '" + rawValue + "'.");

		if (inn.Length != 10 && inn.Length != 12)
			throw new Exception("ИНН должен содержать 10 или 12 цифр, а получено " + inn.Length + ": '" + inn + "'.");

		return inn;
	}

	private void OpenInBrowser(string address)
	{
		Uri url = new Uri(address);

		if (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps)
			throw new Exception("Недопустимый адрес ссылки: '" + url.OriginalString + "'.");

		System.Diagnostics.Process.Start(url.AbsoluteUri);
	}

	private void CopyToClipboard(string text)
	{
		try
		{
			Clipboard.SetText(text);
		}
		catch
		{
			// буфер обмена может быть занят другим приложением — не мешаем работе
		}
	}
}
