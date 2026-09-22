using System;
using System.Collections.Generic;
using System.Net;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;

// ===========================================================================
// Поиск организации на rusprofile.ru по ИНН из карточки объекта.
//
// Что изменено по сравнению с rev1 (причина ошибки 404):
//
//  * Из адреса убран параметр type=ul. Рабочим остаётся только параметр
//    query, а на адрес с type сайт отвечает страницей «404 Страница не
//    найдена». Заодно в адресе больше нет символа «&»: при передаче ссылки
//    в браузер через Process.Start он в некоторых настройках Windows
//    обрезает адрес, и это давало тот же результат — 404.
//
//  * Перед открытием браузера адрес проверяется коротким запросом к сайту.
//    Если сайт отвечает 404, скрипт пробует запасной вариант адреса, а если
//    не работает и он — открывает главную страницу rusprofile.ru и кладёт
//    ИНН в буфер обмена, чтобы его сразу можно было вставить в строку
//    поиска. Пользователь в любом случае получает результат, а не ошибку.
//
//  * Проверка необязательная: если сайт не отвечает из-за прокси, блокировки
//    или защиты от роботов, скрипт просто открывает основной адрес. Проверка
//    не должна мешать работе.
//
//  * ИНН очищается от любых нецифровых символов (у числового атрибута
//    ToString() под русской локалью вставляет пробелы-разделители разрядов)
//    и проверяется на длину 10 или 12 цифр.
//
// Если сайт снова поменяет адрес поиска, достаточно поправить строки
// SearchUrl / SearchUrlAlt в разделе «Настройки».
// ===========================================================================
public class Script
{
	public ICSharpScriptContext ScriptContext { get; private set; }

	#region Настройки

	// Атрибут «ИНН»
	private const string AttrInnGuid = "f72b99e7-9f88-46a2-b020-8b6657ca1313";
	private const string AttrInnName = "ИНН";

	// Адреса поиска: {0} — ИНН, {1} — тип лица (ul — организация, ip — ИП)
	private const string SearchUrl = "https://www.rusprofile.ru/search?query={0}";
	private const string SearchUrlAlt = "https://www.rusprofile.ru/search?query={0}&type={1}";
	private const string SiteUrl = "https://www.rusprofile.ru/";

	// Проверять адрес запросом к сайту перед открытием браузера
	private const bool CheckUrlBeforeOpen = true;
	private const int CheckTimeoutMs = 5000;

	private const string BrowserUserAgent =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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

			bool addressNotFound;
			string url = ResolveUrl(inn, out addressNotFound);

			if (addressNotFound)
			{
				// Ни один из известных адресов поиска не работает — значит,
				// сайт изменил адрес. Открываем главную страницу, а ИНН
				// кладём в буфер обмена для вставки в строку поиска.
				bool copied = CopyToClipboard(inn);

				Show("Страница поиска rusprofile.ru по прежнему адресу больше не открывается." + Environment.NewLine +
					"Открываю главную страницу сайта — поиск по ИНН " + inn + " выполните на ней." +
					(copied ? Environment.NewLine + "ИНН скопирован в буфер обмена." : string.Empty),
					MessageBoxIcon.Warning);

				OpenInBrowser(SiteUrl);
				return parameters;
			}

			OpenInBrowser(url);
		}
		catch (Exception ex)
		{
			Show("Не удалось открыть ссылку." + Environment.NewLine + ex.Message, MessageBoxIcon.Warning);
		}

		return parameters;
	}

	// =======================================================================
	// ИНН
	// =======================================================================

	// Чтение и проверка ИНН из карточки объекта
	private string GetInn(IDBObject obj)
	{
		IDBAttribute attribute = obj.GetAttributeByGuid(new Guid(AttrInnGuid));
		if (attribute == null)
			attribute = obj.Attributes.FindByName(AttrInnName);

		if (attribute == null || attribute.IsNull || attribute.Value == null)
			throw new Exception("ИНН не заполнен. Заполните ИНН организации.");

		// Значение приходит строкой или числом; у числового атрибута
		// ToString() может вставить пробелы-разделители разрядов
		// (например «5 259 077 666»), поэтому оставляем только цифры.
		string rawValue = attribute.Value.ToString();
		string inn = Regex.Replace(rawValue, @"[^\d]", "");

		if (inn.Length == 0)
			throw new Exception("Значение ИНН имеет неверный формат: '" + rawValue + "'.");

		if (inn.Length != 10 && inn.Length != 12)
			throw new Exception("ИНН должен содержать 10 или 12 цифр, а получено " + inn.Length + ": '" + inn + "'.");

		return inn;
	}

	// =======================================================================
	// АДРЕС ПОИСКА
	// =======================================================================

	// Подбор рабочего адреса. addressNotFound = true, только если сайт
	// доступен и на все варианты адреса ответил 404.
	private string ResolveUrl(string inn, out bool addressNotFound)
	{
		addressNotFound = false;

		List<string> candidates = new List<string>();
		candidates.Add(string.Format(SearchUrl, inn));
		candidates.Add(string.Format(SearchUrlAlt, inn, inn.Length == 12 ? "ip" : "ul"));

		if (!CheckUrlBeforeOpen)
			return candidates[0];

		bool siteAnswered = true;

		Cursor.Current = Cursors.WaitCursor;
		try
		{
			foreach (string candidate in candidates)
			{
				bool? available = CheckUrl(candidate);

				if (available == true)
					return candidate;

				if (available == null)
				{
					// Сайт не дал себя проверить (прокси, защита от роботов,
					// нет связи) — проверять остальные адреса смысла нет,
					// открываем основной.
					siteAnswered = false;
					break;
				}
			}
		}
		finally
		{
			Cursor.Current = Cursors.Default;
		}

		addressNotFound = siteAnswered;
		return candidates[0];
	}

	// true — страница открывается, false — сайт ответил 404,
	// null — проверить не удалось
	private bool? CheckUrl(string address)
	{
		HttpWebResponse response = null;
		try
		{
			EnableModernTls();

			HttpWebRequest request = (HttpWebRequest)WebRequest.Create(address);
			request.Method = "GET";
			request.Timeout = CheckTimeoutMs;
			request.ReadWriteTimeout = CheckTimeoutMs;
			request.AllowAutoRedirect = true;
			request.UserAgent = BrowserUserAgent;
			request.Accept = "text/html,application/xhtml+xml";

			// В корпоративной сети запрос идёт через прокси из настроек Windows
			IWebProxy proxy = WebRequest.DefaultWebProxy;
			if (proxy != null)
			{
				proxy.Credentials = CredentialCache.DefaultCredentials;
				request.Proxy = proxy;
			}

			response = (HttpWebResponse)request.GetResponse();
			return (int)response.StatusCode < 400;
		}
		catch (WebException webEx)
		{
			HttpWebResponse errorResponse = webEx.Response as HttpWebResponse;
			if (errorResponse != null)
			{
				int code = (int)errorResponse.StatusCode;
				try { errorResponse.Close(); }
				catch { }

				// 404 и 410 — страницы нет; всё остальное (403, 429, обрыв)
				// означает лишь то, что проверить не дали.
				if (code == 404 || code == 410)
					return false;
			}

			return null;
		}
		catch
		{
			return null;
		}
		finally
		{
			if (response != null)
			{
				try { response.Close(); }
				catch { }
			}
		}
	}

	// На старых версиях .NET TLS 1.1/1.2 по умолчанию выключены,
	// без них запрос к сайту не проходит.
	private void EnableModernTls()
	{
		try
		{
			ServicePointManager.SecurityProtocol =
				ServicePointManager.SecurityProtocol | (SecurityProtocolType)768 | (SecurityProtocolType)3072;
		}
		catch
		{
		}
	}

	// =======================================================================
	// ПРОЧЕЕ
	// =======================================================================

	private void OpenInBrowser(string address)
	{
		Uri url = new Uri(address);

		if (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps)
			throw new Exception("Недопустимый адрес ссылки: '" + url.OriginalString + "'.");

		System.Diagnostics.Process.Start(url.AbsoluteUri);
	}

	private bool CopyToClipboard(string text)
	{
		try
		{
			Clipboard.SetText(text);
			return true;
		}
		catch
		{
			return false;
		}
	}

	private void Show(string text, MessageBoxIcon icon)
	{
		MessageBox.Show(text, DialogCaption, MessageBoxButtons.OK, icon);
	}
}
