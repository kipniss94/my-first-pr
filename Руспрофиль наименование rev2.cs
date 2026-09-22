using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Intermech.Interfaces;
using Intermech.Interfaces.Client;

// ===========================================================================
// Поиск организации на rusprofile.ru по значению атрибута из карточки
// объекта. По умолчанию скрипт настроен на поиск по наименованию.
//
// Почему логика такая:
//
// Сайт сменил адрес поиска, и прежняя ссылка вида
// «/search?query=...&type=ul» отдаёт «404 Страница не найдена» — как из
// скрипта, так и при ручном вводе в браузере. Угадывать новый адрес
// бессмысленно: он поменяется снова. Поэтому скрипт не хранит адрес
// поиска жёстко, а берёт его оттуда же, откуда его берёт браузер —
// из формы поиска на главной странице сайта:
//
//   1. читает главную страницу rusprofile.ru;
//   2. находит в ней форму поиска (адрес, метод и имя поля запроса);
//   3. выполняет поиск так же, как это сделала бы форма;
//   4. если в результатах однозначно определяется организация —
//      открывает в браузере сразу её карточку, иначе открывает страницу
//      результатов поиска (для поиска по наименованию это обычный
//      случай: организаций с похожими названиями много);
//   5. если сайт недоступен или форма не распознана — открывает главную
//      страницу и показывает, что именно не получилось.
//
// Значение запроса при этом всегда кладётся в буфер обмена: на любой
// странице сайта его можно вставить в строку поиска, не возвращаясь в
// карточку.
//
// Чтобы искать по другому атрибуту (например по ИНН), достаточно
// поменять в разделе «Настройки» три строки: AttrGuid, AttrName и
// DigitsOnly.
// ===========================================================================
public class Script
{
	public ICSharpScriptContext ScriptContext { get; private set; }

	#region Настройки

	// Атрибут, значение которого ищется на сайте
	private const string AttrGuid = "cad00020-306c-11d8-b4e9-00304f19f545";
	private const string AttrName = "Наименование";

	// true — значение является ИНН: очищается до цифр, проверяется на
	// длину 10 или 12 знаков, а в результатах поиска по нему уточняется
	// карточка организации. false — значение ищется как обычный текст.
	private readonly bool DigitsOnly = false;

	// Сайт
	private const string SiteUrl = "https://www.rusprofile.ru/";

	// Готовый адрес поиска, {0} — ИНН. Если задан, используется сразу,
	// без чтения формы с сайта. Например:
	// "https://www.rusprofile.ru/search?query={0}"
	private const string ForcedSearchUrl = "";

	// Запасные адреса поиска — на случай, если форму на главной странице
	// распознать не удалось. Проверяются по очереди, {0} — ИНН.
	private readonly string[] KnownSearchUrls = new string[]
	{
		"https://www.rusprofile.ru/search-advanced?query={0}",
		"https://www.rusprofile.ru/search?query={0}"
	};

	// Имена полей, в которые форма кладёт поисковый запрос
	private readonly string[] QueryFieldNames = new string[]
	{
		"query", "q", "search", "search_query", "searchquery", "text", "inn", "name"
	};

	private const int RequestTimeoutMs = 10000;
	private const bool CopyQueryToClipboard = true;

	private const string BrowserUserAgent =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

	private const string DialogCaption = "Поиск организации на rusprofile.ru";

	#endregion

	// Код ответа на последний запрос: 0 — сайт не ответил вовсе
	private int lastStatusCode;

	// Запрос поиска, собранный по форме сайта
	private class SearchRequest
	{
		public string Url;          // адрес запроса
		public bool Post;           // форма отправляется методом POST
		public string Body;         // тело POST-запроса
		public string Referer;      // страница, с которой «отправлена» форма
		public string BrowserUrl;   // что открыть в браузере (только для GET)
	}

	public AttributeValidationScriptParameters Execute(AttributeValidationScriptParameters parameters)
	{
		List<string> log = new List<string>();

		try
		{
			IUserSession session = parameters.UserSession;

			IDBObject obj = session.GetObject(parameters.ObjectID);
			if (obj == null)
				throw new Exception("Не удалось получить объект, с карточки которого вызван скрипт.");

			string query = GetQuery(obj);

			// При поиске по ИНН его же используем как признак нужной
			// организации в результатах поиска
			string marker = DigitsOnly ? query : string.Empty;

			if (CopyQueryToClipboard)
				CopyToClipboard(query);

			string target;
			Cursor.Current = Cursors.WaitCursor;
			try
			{
				target = ResolveTarget(query, marker, log);
			}
			finally
			{
				Cursor.Current = Cursors.Default;
			}

			if (string.IsNullOrEmpty(target))
			{
				// Ни поиск по форме, ни запасные адреса не сработали.
				// Открываем главную страницу и показываем, что было сделано.
				Show("Не удалось выполнить поиск «" + query + "» на rusprofile.ru." + Environment.NewLine +
					"Открываю главную страницу сайта, значение скопировано в буфер обмена — вставьте его в строку поиска." +
					Environment.NewLine + Environment.NewLine + "Что сделал скрипт:" + Environment.NewLine +
					string.Join(Environment.NewLine, log.ToArray()), MessageBoxIcon.Warning);

				OpenInBrowser(SiteUrl);
				return parameters;
			}

			OpenInBrowser(target);
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

	// Чтение и проверка значения запроса из карточки объекта
	private string GetQuery(IDBObject obj)
	{
		IDBAttribute attribute = obj.GetAttributeByGuid(new Guid(AttrGuid));
		if (attribute == null)
			attribute = obj.Attributes.FindByName(AttrName);

		if (attribute == null || attribute.IsNull || attribute.Value == null)
			throw new Exception("Атрибут «" + AttrName + "» не заполнен.");

		string rawValue = attribute.Value.ToString();

		if (DigitsOnly)
		{
			// У числового атрибута ToString() под русской локалью вставляет
			// пробелы-разделители разрядов («7 811 610 264»), поэтому
			// оставляем только цифры.
			string digits = Regex.Replace(rawValue, @"[^\d]", "");

			if (digits.Length == 0)
				throw new Exception("Значение атрибута «" + AttrName + "» имеет неверный формат: '" + rawValue + "'.");

			if (digits.Length != 10 && digits.Length != 12)
				throw new Exception("ИНН должен содержать 10 или 12 цифр, а получено " + digits.Length + ": '" + digits + "'.");

			return digits;
		}

		// Текстовое значение: убираем повторяющиеся пробелы и переносы строк
		string text = Regex.Replace(rawValue, @"\s+", " ").Trim();

		if (text.Length < 2)
			throw new Exception("Значение атрибута «" + AttrName + "» слишком короткое для поиска: '" + rawValue + "'.");

		return text;
	}

	// =======================================================================
	// ПОИСК
	// =======================================================================

	// Возвращает адрес, который нужно открыть в браузере (карточку
	// организации или страницу результатов), либо null, если не вышло.
	private string ResolveTarget(string query, string marker, List<string> log)
	{
		if (!string.IsNullOrEmpty(ForcedSearchUrl))
			return string.Format(ForcedSearchUrl, Uri.EscapeDataString(query));

		CookieContainer cookies = new CookieContainer();
		List<SearchRequest> requests = new List<SearchRequest>();

		// 1. Адрес поиска берём из формы на главной странице сайта
		string finalUrl;
		string homeHtml = Download(new SearchRequest { Url = SiteUrl }, cookies, log, out finalUrl);

		if (homeHtml != null)
		{
			SearchRequest fromForm = BuildRequestFromForm(homeHtml, finalUrl, query, log);
			if (fromForm != null)
				requests.Add(fromForm);
		}
		else if (lastStatusCode == 0)
		{
			// Сайт не отвечает совсем — запасные адреса проверять незачем
			return null;
		}

		// 2. Запасные адреса — на случай, если форму распознать не удалось
		foreach (string template in KnownSearchUrls)
		{
			string url = string.Format(template, Uri.EscapeDataString(query));

			bool alreadyAdded = false;
			foreach (SearchRequest existing in requests)
			{
				if (!existing.Post && string.Equals(existing.Url, url, StringComparison.OrdinalIgnoreCase))
					alreadyAdded = true;
			}

			if (!alreadyAdded)
				requests.Add(new SearchRequest { Url = url, Referer = SiteUrl, BrowserUrl = url });
		}

		// 3. Выполняем поиск
		foreach (SearchRequest request in requests)
		{
			string resultUrl;
			string html = Download(request, cookies, log, out resultUrl);
			if (html == null)
				continue;

			// Сайт сам перешёл на карточку организации
			if (IsCardUrl(resultUrl))
			{
				log.Add("сайт открыл карточку организации");
				return resultUrl;
			}

			string card = ExtractCardUrl(html, resultUrl, marker);
			if (!string.IsNullOrEmpty(card))
			{
				log.Add("карточка организации найдена в результатах поиска");
				return card;
			}

			// Результаты открылись, но однозначной карточки нет —
			// показываем пользователю страницу результатов
			if (!request.Post && !string.IsNullOrEmpty(request.BrowserUrl))
			{
				log.Add("открываю страницу результатов поиска");
				return request.BrowserUrl;
			}
		}

		return null;
	}

	// Разбор формы поиска на странице сайта
	private SearchRequest BuildRequestFromForm(string html, string pageUrl, string query, List<string> log)
	{
		foreach (Match form in Regex.Matches(html, @"<form\b([^>]*)>(.*?)</form>",
			RegexOptions.IgnoreCase | RegexOptions.Singleline))
		{
			string attributes = form.Groups[1].Value;
			string body = form.Groups[2].Value;

			string action = GetAttributeValue(attributes, "action");
			string method = GetAttributeValue(attributes, "method");

			// Поле, в которое форма кладёт запрос, и скрытые поля формы
			string queryField = null;
			List<string> hidden = new List<string>();

			foreach (Match input in Regex.Matches(body, @"<input\b[^>]*>", RegexOptions.IgnoreCase))
			{
				string tag = input.Value;
				string name = GetAttributeValue(tag, "name");
				if (string.IsNullOrEmpty(name))
					continue;

				string type = GetAttributeValue(tag, "type");
				if (string.Equals(type, "hidden", StringComparison.OrdinalIgnoreCase))
				{
					hidden.Add(Uri.EscapeDataString(name) + "=" +
						Uri.EscapeDataString(GetAttributeValue(tag, "value") ?? string.Empty));
					continue;
				}

				if (queryField == null && IsQueryField(name, type))
					queryField = name;
			}

			if (queryField == null)
				continue;

			// Форма без action отправляется на ту же страницу
			string targetUrl = ToAbsoluteUrl(string.IsNullOrEmpty(action) ? pageUrl : action, pageUrl);
			if (targetUrl == null)
				continue;

			bool post = string.Equals(method, "post", StringComparison.OrdinalIgnoreCase);

			string fields = Uri.EscapeDataString(queryField) + "=" + Uri.EscapeDataString(query);
			foreach (string field in hidden)
				fields += "&" + field;

			SearchRequest request = new SearchRequest();
			request.Post = post;
			request.Referer = pageUrl;

			if (post)
			{
				request.Url = targetUrl;
				request.Body = fields;
			}
			else
			{
				request.Url = targetUrl + (targetUrl.IndexOf('?') >= 0 ? "&" : "?") + fields;
				request.BrowserUrl = request.Url;
			}

			log.Add("форма поиска: " + (post ? "POST " : "GET ") + targetUrl + ", поле «" + queryField + "»");
			return request;
		}

		log.Add("форма поиска на главной странице не найдена");
		return null;
	}

	private bool IsQueryField(string name, string type)
	{
		if (!string.IsNullOrEmpty(type) &&
			!string.Equals(type, "text", StringComparison.OrdinalIgnoreCase) &&
			!string.Equals(type, "search", StringComparison.OrdinalIgnoreCase))
			return false;

		foreach (string known in QueryFieldNames)
		{
			if (string.Equals(name, known, StringComparison.OrdinalIgnoreCase))
				return true;
		}

		return false;
	}

	// Значение атрибута HTML-тега
	private string GetAttributeValue(string tag, string name)
	{
		Match match = Regex.Match(tag, @"\b" + name + @"\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s""'>]+))",
			RegexOptions.IgnoreCase);

		if (!match.Success)
			return null;

		string value = match.Groups[1].Success ? match.Groups[1].Value
			: match.Groups[2].Success ? match.Groups[2].Value
			: match.Groups[3].Value;

		return DecodeHtml(value);
	}

	private string DecodeHtml(string text)
	{
		if (string.IsNullOrEmpty(text))
			return text;

		return text.Replace("&amp;", "&").Replace("&quot;", "\"").Replace("&#39;", "'").Trim();
	}

	private string ToAbsoluteUrl(string url, string baseUrl)
	{
		try
		{
			return new Uri(new Uri(baseUrl), url).AbsoluteUri;
		}
		catch
		{
			return null;
		}
	}

	// Адрес карточки организации — .../id/<число>
	private bool IsCardUrl(string url)
	{
		return !string.IsNullOrEmpty(url) && Regex.IsMatch(url, @"/id/\d+", RegexOptions.IgnoreCase);
	}

	// Поиск карточки организации в результатах.
	// Ссылок на карточки на странице может быть много (реклама, похожие
	// организации), поэтому карточка возвращается, только если она одна
	// или если рядом с ней на странице указан маркер — искомый ИНН.
	// При поиске по наименованию маркера нет, и несколько результатов
	// означают, что выбирать должен пользователь.
	private string ExtractCardUrl(string html, string pageUrl, string marker)
	{
		List<string> found = new List<string>();
		string nearInn = null;

		foreach (Match match in Regex.Matches(html, @"href\s*=\s*[""']([^""']*?/id/\d+)[""']", RegexOptions.IgnoreCase))
		{
			string href = DecodeHtml(match.Groups[1].Value);
			string absolute = ToAbsoluteUrl(href, pageUrl);
			if (absolute == null)
				continue;

			if (!found.Contains(absolute))
				found.Add(absolute);

			if (nearInn == null && !string.IsNullOrEmpty(marker) && IsNearMarker(html, match.Index, marker))
				nearInn = absolute;
		}

		if (nearInn != null)
			return nearInn;

		return found.Count == 1 ? found[0] : null;
	}

	// Упоминается ли маркер рядом со ссылкой (в пределах блока результата)
	private bool IsNearMarker(string html, int position, string marker)
	{
		const int Window = 2000;

		int start = Math.Max(0, position - Window);
		int length = Math.Min(html.Length - start, Window * 2);

		return html.IndexOf(marker, start, length, StringComparison.Ordinal) >= 0;
	}

	// =======================================================================
	// ЗАПРОСЫ К САЙТУ
	// =======================================================================

	private string Download(SearchRequest request, CookieContainer cookies, List<string> log, out string finalUrl)
	{
		finalUrl = request.Url;

		HttpWebResponse response = null;
		try
		{
			EnableModernTls();

			HttpWebRequest webRequest = (HttpWebRequest)WebRequest.Create(request.Url);
			webRequest.Method = request.Post ? "POST" : "GET";
			webRequest.Timeout = RequestTimeoutMs;
			webRequest.ReadWriteTimeout = RequestTimeoutMs;
			webRequest.AllowAutoRedirect = true;
			webRequest.UserAgent = BrowserUserAgent;
			webRequest.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
			webRequest.Headers.Add("Accept-Language", "ru-RU,ru;q=0.9");
			webRequest.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
			webRequest.CookieContainer = cookies;

			if (!string.IsNullOrEmpty(request.Referer))
				webRequest.Referer = request.Referer;

			// В корпоративной сети запрос идёт через прокси из настроек Windows
			IWebProxy proxy = WebRequest.DefaultWebProxy;
			if (proxy != null)
			{
				proxy.Credentials = CredentialCache.DefaultCredentials;
				webRequest.Proxy = proxy;
			}

			if (request.Post)
			{
				byte[] body = Encoding.UTF8.GetBytes(request.Body == null ? string.Empty : request.Body);
				webRequest.ContentType = "application/x-www-form-urlencoded";
				webRequest.ContentLength = body.Length;

				using (Stream stream = webRequest.GetRequestStream())
					stream.Write(body, 0, body.Length);
			}

			response = (HttpWebResponse)webRequest.GetResponse();
			finalUrl = response.ResponseUri.AbsoluteUri;
			lastStatusCode = (int)response.StatusCode;

			log.Add(ShortUrl(request.Url) + " — ответ " + (int)response.StatusCode);

			using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
				return reader.ReadToEnd();
		}
		catch (WebException webEx)
		{
			HttpWebResponse errorResponse = webEx.Response as HttpWebResponse;

			if (errorResponse != null)
			{
				lastStatusCode = (int)errorResponse.StatusCode;
				log.Add(ShortUrl(request.Url) + " — ответ " + (int)errorResponse.StatusCode);
				try { errorResponse.Close(); }
				catch { }
			}
			else
			{
				lastStatusCode = 0;
				log.Add(ShortUrl(request.Url) + " — нет связи: " + webEx.Message);
			}

			return null;
		}
		catch (Exception ex)
		{
			lastStatusCode = 0;
			log.Add(ShortUrl(request.Url) + " — ошибка: " + ex.Message);
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

	private string ShortUrl(string url)
	{
		try
		{
			Uri parsed = new Uri(url);
			return parsed.PathAndQuery == "/" ? "главная страница" : parsed.PathAndQuery;
		}
		catch
		{
			return url;
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

	private void Show(string text, MessageBoxIcon icon)
	{
		MessageBox.Show(text, DialogCaption, MessageBoxButtons.OK, icon);
	}
}
