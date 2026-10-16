# Заглушки API IPS для проверки компиляции

Настоящих сборок IPS нет, поэтому скрипты проверяются на заглушках (mono):

    mcs -target:library -out:x.dll -r:System.Data.dll -r:System.Core.dll "Скрипт.cs" tools/stubs/ips-stubs.cs

- System.Windows.Forms намеренно не подключён — так ведёт себя сервер приложений (отчёты).
- Для клиентских скриптов (кнопки на формах) добавьте -r:System.Windows.Forms.dll.
- Заглушки описывают только то, что встречалось в наших скриптах; при новом API дописывайте их.
- example-report-test.cs — пример прогона отчёта (сценарий DBReportScenario) с поддельной сессией,
  составом и календарём.
