using System;
using System.Windows.Forms;
using LegacyApp.DataAccess;

namespace LegacyApp.Forms
{
    public partial class OrderForm : Form
    {
        private readonly OrderRepository repository = new OrderRepository();

        public OrderForm()
        {
            InitializeComponent();
        }

        private void OrderForm_Load(object sender, EventArgs e)
        {
            txtCustomerName.Text = string.Empty;
        }

        private void btnSave_Click(object sender, EventArgs e)
        {
            int qty;
            if (!int.TryParse(txtQuantity.Text, out qty))
            {
                MessageBox.Show("数量は数値で入力してください。", "入力エラー", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                txtQuantity.Focus();
                return;
            }
            repository.Save(txtCustomerName.Text, qty);
        }

        private void txtCustomerName_Leave(object sender, EventArgs e)
        {
            txtCustomerName.Text = txtCustomerName.Text.Trim();
        }

        private void mnuFileExit_Click(object sender, EventArgs e)
        {
            Close();
        }

        private void tmrAutoSave_Tick(object sender, EventArgs e)
        {
        }
    }
}
