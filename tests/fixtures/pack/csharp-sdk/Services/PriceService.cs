namespace SdkApp.Services;

public static class PriceService
{
    public static decimal Total(decimal unitPrice, int quantity) => unitPrice * quantity;
}
