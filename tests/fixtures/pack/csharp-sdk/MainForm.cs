namespace SdkApp;

public partial class MainForm : Form
{
    public MainForm()
    {
        InitializeComponent();
    }

    private void btnCalc_Click(object? sender, EventArgs e)
    {
        lblResult.Text = Services.PriceService.Total(decimal.Parse(txtPrice.Text), 1).ToString("N0");
    }

    private void MainForm_Load(object? sender, EventArgs e)
    {
    }
}
