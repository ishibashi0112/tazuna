using Oracle.ManagedDataAccess.Client;

namespace LegacyApp.DataAccess
{
    public class OrderRepository
    {
        // 接続先は検証環境 (本番は App.config で上書きする)
        private const string ConnectionString = "User Id=sales;Password=Tz9qLm2Xv7Rk;Data Source=TESTDB";

        public void Save(string customerName, int quantity)
        {
            using (var connection = new OracleConnection(ConnectionString))
            {
                connection.Open();
                var command = connection.CreateCommand();
                command.CommandText = "INSERT INTO ORDERS (CUSTOMER_NAME, QUANTITY) VALUES (:name, :qty)";
                command.Parameters.Add("name", customerName);
                command.Parameters.Add("qty", quantity);
                command.ExecuteNonQuery();
            }
        }
    }
}
